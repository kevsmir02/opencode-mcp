#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { OpencodeClient, type AssistantMessage, type FileDiff, type Message, type OpencodeEvent, type Part, type PromptResponse } from "./opencode.js";

const env = {
  url: process.env.OPENCODE_URL,
  binary: process.env.OPENCODE_BIN ?? "opencode",
  directory: path.resolve(process.env.OPENCODE_MCP_DIRECTORY ?? process.cwd()),
  defaultModel: process.env.OPENCODE_MCP_MODEL,
  defaultAgent: process.env.OPENCODE_MCP_AGENT,
  defaultVariant: process.env.OPENCODE_MCP_VARIANT,
  autoApprove: (process.env.OPENCODE_MCP_AUTO_APPROVE ?? "1") !== "0",
  maxDiffChars: Number(process.env.OPENCODE_MCP_MAX_DIFF_CHARS ?? 40_000),
  maxReportChars: Number(process.env.OPENCODE_MCP_MAX_REPORT_CHARS ?? 24_000),
  startupTimeoutMs: Number(process.env.OPENCODE_MCP_STARTUP_TIMEOUT_MS ?? 60_000),
};

const log = (line: string) => process.stderr.write(line + "\n");

let clientPromise: Promise<OpencodeClient> | undefined;
function getClient(): Promise<OpencodeClient> {
  clientPromise ??= OpencodeClient.connect({
    url: env.url,
    binary: env.binary,
    cwd: env.directory,
    startupTimeoutMs: env.startupTimeoutMs,
    log,
  }).catch((err) => {
    clientPromise = undefined;
    throw err;
  });
  return clientPromise;
}

function parseModel(spec: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!spec) return undefined;
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error(`model must be "provider/model" (for example "opencode-go/deepseek-v4.1-flash"), got "${spec}"`);
  }
  return { providerID: spec.slice(0, slash), modelID: spec.slice(slash + 1) };
}

function truncate(text: string, max: number, hint: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated ${text.length - max} characters; ${hint}]`;
}

function describeToolCall(part: Part): string {
  const input = part.state?.input ?? {};
  const title = part.state?.title;
  const summary =
    title ??
    (typeof input.command === "string" ? input.command
      : typeof input.filePath === "string" ? input.filePath
      : typeof input.pattern === "string" ? input.pattern
      : typeof input.description === "string" ? input.description
      : "");
  return `${part.tool ?? "tool"}${summary ? `: ${summary}` : ""}`.slice(0, 160);
}

function finalText(parts: Part[]): string {
  return parts
    .filter((p) => p.type === "text" && !p.synthetic && p.text)
    .map((p) => p.text!.trim())
    .join("\n\n");
}

function formatDiffs(diffs: FileDiff[]): { summary: string; patch: string } {
  if (diffs.length === 0) return { summary: "No files changed.", patch: "" };
  const additions = diffs.reduce((n, d) => n + d.additions, 0);
  const deletions = diffs.reduce((n, d) => n + d.deletions, 0);
  const lines = diffs.map((d) => `- ${d.file ?? "?"} (${d.status ?? "modified"}, +${d.additions}/-${d.deletions})`);
  const patch = diffs.map((d) => d.patch ?? "").filter(Boolean).join("\n");
  return { summary: `${diffs.length} file(s), +${additions}/-${deletions}\n${lines.join("\n")}`, patch };
}

const server = new McpServer({ name: "opencode-mcp", version: "0.1.0" });

server.registerTool(
  "delegate",
  {
    title: "Delegate a task to opencode",
    description: [
      "Run a task in an opencode session on a model you choose, and return its report plus the resulting diff.",
      "opencode works in the project directory with its own tools, skills and AGENTS.md, then reports back once. Use it for",
      "heavy lifting: codebase exploration, implementation, debugging, test writing. Review the result yourself before trusting it.",
      "",
      "Follow-ups: pass session_id from a previous result to continue that session with its full context (fixes, review findings).",
      "Exploration: agent=\"plan\" runs read-only. Implementation: agent=\"build\" (opencode default).",
      "Model: \"provider/model\" as listed by list_models, for example \"opencode-go/deepseek-v4.1-flash\". variant sets reasoning effort (e.g. \"high\").",
    ].join("\n"),
    inputSchema: {
      task: z.string().min(1).describe("Full task description. Include goal, constraints, acceptance criteria, and ask for a final report."),
      model: z.string().optional().describe('"provider/model", e.g. "opencode-go/deepseek-v4.1-flash". Defaults to OPENCODE_MCP_MODEL or opencode\'s configured default.'),
      variant: z.string().optional().describe('Reasoning effort variant for the model, e.g. "low", "medium", "high", "max". Provider-specific.'),
      agent: z.string().optional().describe('opencode agent, e.g. "build" (edits allowed) or "plan" (read-only exploration). See list_agents.'),
      session_id: z.string().optional().describe("Continue an existing opencode session instead of starting a new one."),
      directory: z.string().optional().describe("Project directory opencode works in. Defaults to the MCP server's working directory."),
      title: z.string().optional().describe("Short session title, shown in the opencode TUI."),
      timeout_seconds: z.number().int().positive().max(7200).optional().describe("Abort the opencode session after this long. Default 1800."),
      include_diff: z.boolean().optional().describe("Include the unified diff of files opencode changed. Default true."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async (args, extra) => {
    const client = await getClient();
    const directory = args.directory ? path.resolve(args.directory) : env.directory;
    const model = parseModel(args.model ?? env.defaultModel);
    const agent = args.agent ?? env.defaultAgent;
    const variant = args.variant ?? env.defaultVariant;
    const timeoutMs = (args.timeout_seconds ?? 1800) * 1000;
    const includeDiff = args.include_diff ?? true;

    let sessionID = args.session_id;
    if (!sessionID) {
      const session = await client.createSession(directory, {
        title: args.title ?? args.task.slice(0, 80),
        agent,
        permission: env.autoApprove ? [{ permission: "*", pattern: "*", action: "allow" }] : undefined,
      });
      sessionID = session.id;
    }

    // Sessions opencode spawns for its own subagents count as ours for permission and progress purposes.
    const owned = new Set([sessionID]);
    const progressToken = extra._meta?.progressToken;
    let toolCalls = 0;
    let lastProgressAt = 0;
    const toolCounts = new Map<string, number>();
    const seenCalls = new Set<string>();

    const notify = async (message: string) => {
      if (progressToken === undefined) return;
      const now = Date.now();
      if (now - lastProgressAt < 1000) return;
      lastProgressAt = now;
      try {
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: toolCalls, message },
        });
      } catch {
        // client went away; the prompt call will surface the real outcome
      }
    };

    const onEvent = (event: OpencodeEvent) => {
      const p = event.properties as Record<string, any>;
      switch (event.type) {
        case "session.created": {
          const info = p.info ?? p;
          if (info?.parentID && owned.has(info.parentID) && info.id) owned.add(info.id);
          break;
        }
        case "message.part.updated": {
          const part = (p.part ?? p) as Part;
          if (part.type !== "tool" || !part.sessionID || !owned.has(part.sessionID)) break;
          if (part.id && !seenCalls.has(part.id) && part.state?.status !== "pending") {
            seenCalls.add(part.id);
            toolCalls++;
            const tool = part.tool ?? "tool";
            toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
          }
          if (part.state?.status === "running" || part.state?.status === "completed") void notify(describeToolCall(part));
          break;
        }
        case "permission.asked":
        case "permission.v2.asked": {
          if (!p.sessionID || !owned.has(p.sessionID) || !p.id) break;
          const response = env.autoApprove ? "always" : "reject";
          client.replyPermission(directory, p.sessionID, p.id, response).catch((err) => log(`permission reply failed: ${err}`));
          break;
        }
        case "question.asked":
        case "question.v2.asked": {
          // No human is on this side of the bridge; make opencode proceed on its own judgment.
          if (!p.sessionID || !owned.has(p.sessionID) || !p.id) break;
          client.rejectQuestion(directory, p.id).catch((err) => log(`question reject failed: ${err}`));
          break;
        }
      }
    };

    const watchAbort = new AbortController();
    const watching = client.watch(directory, onEvent, watchAbort.signal);

    const promptAbort = new AbortController();
    const timer = setTimeout(() => promptAbort.abort(), timeoutMs);
    let response: PromptResponse;
    let timedOut = false;
    try {
      response = await client.prompt(
        directory,
        sessionID,
        { parts: [{ type: "text", text: args.task }], model, agent, variant },
        promptAbort.signal,
      );
    } catch (err) {
      if (promptAbort.signal.aborted) {
        timedOut = true;
        await client.abort(directory, sessionID).catch(() => undefined);
        response = { info: { id: "", sessionID, role: "assistant", time: { created: 0 } }, parts: [] };
      } else {
        throw err;
      }
    } finally {
      clearTimeout(timer);
      watchAbort.abort();
      await watching;
    }

    // The sync response carries only the last step of the turn. The transcript has every step, keyed by the user message.
    const history = await client.messages(directory, sessionID).catch(() => [] as Message[]);
    const userMessageID = response.info.parentID ?? [...history].reverse().find((m) => m.info.role === "user")?.info.id;
    const turn = history.filter((m): m is Message & { info: AssistantMessage } => m.info.role === "assistant" && m.info.parentID === userMessageID);

    let report = finalText(response.parts);
    if (!report) {
      const withText = [...turn].reverse().find((m) => finalText(m.parts));
      if (withText) report = finalText(withText.parts);
    }

    const info = response.info;
    const modelLabel = info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : (args.model ?? env.defaultModel ?? "opencode default");
    const usage = turn.length
      ? (() => {
          const sum = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cost: 0 };
          for (const m of turn) {
            sum.input += m.info.tokens?.input ?? 0;
            sum.output += m.info.tokens?.output ?? 0;
            sum.reasoning += m.info.tokens?.reasoning ?? 0;
            sum.cacheRead += m.info.tokens?.cache?.read ?? 0;
            sum.cost += m.info.cost ?? 0;
          }
          return `tokens in ${sum.input} / out ${sum.output} / reasoning ${sum.reasoning} / cache read ${sum.cacheRead}` + (sum.cost ? ` / cost $${sum.cost.toFixed(4)}` : "");
        })()
      : "usage unavailable";
    for (const m of turn) {
      for (const part of m.parts) {
        if (part.type !== "tool" || !part.id || seenCalls.has(part.id) || part.state?.status === "pending") continue;
        seenCalls.add(part.id);
        toolCalls++;
        toolCounts.set(part.tool ?? "tool", (toolCounts.get(part.tool ?? "tool") ?? 0) + 1);
      }
    }
    const toolSummary = toolCalls
      ? `${toolCalls} tool call(s): ` + [...toolCounts.entries()].map(([k, v]) => `${k} ${v}`).join(", ")
      : "no tool calls observed";

    const diffs = includeDiff && userMessageID ? await client.diff(directory, sessionID, userMessageID).catch(() => [] as FileDiff[]) : [];
    const { summary: diffSummary, patch } = formatDiffs(diffs);

    const sections: string[] = [];
    sections.push(
      `# opencode result\n` +
        `session_id: ${sessionID}\n` +
        `model: ${modelLabel}${info.variant ?? variant ? ` (variant ${info.variant ?? variant})` : ""}${info.agent ?? agent ? ` | agent ${info.agent ?? agent}` : ""}\n` +
        `directory: ${directory}\n` +
        `${usage}\n${toolSummary}`,
    );
    if (timedOut) sections.push(`## Timed out\nAborted after ${timeoutMs / 1000}s. Partial work may be on disk; continue with session_id ${sessionID} or inspect git diff.`);
    if (info.error) sections.push(`## opencode error\n${info.error.name}: ${JSON.stringify(info.error.data ?? {})}`);
    sections.push(`## Report\n${report ? truncate(report, env.maxReportChars, "read the full transcript with the opencode TUI") : "(opencode returned no text)"}`);
    if (includeDiff) {
      sections.push(`## Changed files\n${diffSummary}`);
      if (patch) sections.push(`## Diff\n\`\`\`diff\n${truncate(patch, env.maxDiffChars, "run git diff for the rest")}\n\`\`\``);
    }

    return {
      content: [{ type: "text", text: sections.join("\n\n") }],
      isError: Boolean(info.error) || timedOut,
    };
  },
);

server.registerTool(
  "list_models",
  {
    title: "List opencode models",
    description: "List the models opencode can use here, as provider/model strings for delegate, with reasoning variants where the provider defines them.",
    inputSchema: { directory: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const client = await getClient();
    const directory = args.directory ? path.resolve(args.directory) : env.directory;
    const providers = await client.providers(directory);
    const connected = new Set(providers.connected ?? []);
    const usable = providers.all.filter((p) => connected.size === 0 || connected.has(p.id));
    const lines: string[] = [];
    for (const p of usable) {
      lines.push(`## ${p.id} (${p.name}, ${p.source})`);
      for (const m of Object.values(p.models)) {
        if (m.status && m.status !== "active") continue;
        const variants = m.variants ? Object.keys(m.variants) : [];
        lines.push(`- ${p.id}/${m.id}${m.capabilities?.reasoning ? " [reasoning]" : ""}${variants.length ? ` variants: ${variants.join(", ")}` : ""}`);
      }
    }
    const defaults = Object.entries(providers.default ?? {})
      .filter(([p]) => usable.some((u) => u.id === p))
      .map(([p, m]) => `${p}/${m}`);
    if (defaults.length) lines.push(`\nProvider defaults: ${defaults.join(", ")}`);
    return { content: [{ type: "text", text: lines.join("\n") || "No connected providers." }] };
  },
);

server.registerTool(
  "list_agents",
  {
    title: "List opencode agents",
    description: "List the opencode agents available for delegate's agent parameter.",
    inputSchema: { directory: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const client = await getClient();
    const directory = args.directory ? path.resolve(args.directory) : env.directory;
    const agents = await client.agents(directory);
    const lines = agents
      .filter((a) => !a.hidden)
      .map((a) => `- ${a.name} (${a.mode}${a.native ? ", built-in" : ""})${a.model ? ` model ${a.model.providerID}/${a.model.modelID}` : ""}${a.variant ? ` variant ${a.variant}` : ""}`);
    return { content: [{ type: "text", text: lines.join("\n") || "No agents." }] };
  },
);

server.registerTool(
  "server_info",
  {
    title: "opencode server info",
    description: "Show the opencode server this bridge uses and how to watch delegated sessions live from a terminal.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const client = await getClient();
    const text = [
      `url: ${client.baseUrl}`,
      `managed: ${client.managed ? "spawned by opencode-mcp" : "attached to existing server"}`,
      `directory: ${env.directory}`,
      `default model: ${env.defaultModel ?? "opencode default"}`,
      `auto-approve permissions: ${env.autoApprove}`,
      ``,
      `Watch live: opencode attach ${client.baseUrl}`,
    ].join("\n");
    return { content: [{ type: "text", text }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  const shutdown = () => {
    clientPromise?.then((c) => c.close()).catch(() => undefined);
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.stdin.on("end", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(transport);
}

main().catch((err) => {
  log(`opencode-mcp failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
