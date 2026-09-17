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

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
type ProgressSink = { token: string | number; send: (params: { progressToken: string | number; progress: number; message: string }) => Promise<unknown> };

/** One delegated turn. Lives in this process until the prompt settles, then keeps its result for `wait`. */
interface Run {
  sessionID: string;
  directory: string;
  startedAt: number;
  timeoutMs: number;
  toolCalls: number;
  toolCounts: Map<string, number>;
  seenCalls: Set<string>;
  lastActivity: string;
  sink?: ProgressSink;
  done: Promise<ToolResult>;
  result?: ToolResult;
}

const runs = new Map<string, Run>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function attachProgress(run: Run, extra: { _meta?: { progressToken?: string | number }; sendNotification: (n: any) => Promise<void> }): () => void {
  const token = extra._meta?.progressToken;
  if (token === undefined) return () => undefined;
  const sink: ProgressSink = { token, send: (params) => extra.sendNotification({ method: "notifications/progress", params }) };
  run.sink = sink;
  return () => {
    if (run.sink === sink) run.sink = undefined;
  };
}

function elapsedLabel(run: Run): string {
  return `${Math.round((Date.now() - run.startedAt) / 1000)}s`;
}

function toolSummary(run: Run): string {
  return run.toolCalls
    ? `${run.toolCalls} tool call(s): ` + [...run.toolCounts.entries()].map(([k, v]) => `${k} ${v}`).join(", ")
    : "no tool calls observed";
}

function runningResult(run: Run | undefined, sessionID: string, directory: string): ToolResult {
  const lines = [
    `# opencode running`,
    `session_id: ${sessionID}`,
    `directory: ${directory}`,
    run ? `elapsed: ${elapsedLabel(run)} (hard abort at ${run.timeoutMs / 1000}s)` : `started outside this bridge process; elapsed unknown`,
    run ? toolSummary(run) : "",
    run?.lastActivity ? `last activity: ${run.lastActivity}` : "",
    ``,
    `Still working. Call wait with this session_id to collect the report and diff, or cancel to stop it.`,
  ].filter((l) => l !== "");
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

/** Turns a finished turn into the tool result. `response` is the sync prompt reply when we have one; otherwise the transcript decides. */
async function buildResult(
  client: OpencodeClient,
  run: Run,
  opts: { response?: PromptResponse; timedOut: boolean; includeDiff: boolean; labels: { model?: string; agent?: string; variant?: string } },
): Promise<ToolResult> {
  const { sessionID, directory } = run;
  const history = await client.messages(directory, sessionID).catch(() => [] as Message[]);
  const userMessageID = opts.response?.info.parentID ?? [...history].reverse().find((m) => m.info.role === "user")?.info.id;
  const turn = history.filter((m): m is Message & { info: AssistantMessage } => m.info.role === "assistant" && m.info.parentID === userMessageID);
  const response: PromptResponse = opts.response ?? turn[turn.length - 1] ?? { info: { id: "", sessionID, role: "assistant", time: { created: 0 } }, parts: [] };

  let report = finalText(response.parts);
  if (!report) {
    const withText = [...turn].reverse().find((m) => finalText(m.parts));
    if (withText) report = finalText(withText.parts);
  }

  const info = response.info;
  const modelLabel = info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : (opts.labels.model ?? "opencode default");
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
      if (part.type !== "tool" || !part.id || run.seenCalls.has(part.id) || part.state?.status === "pending") continue;
      run.seenCalls.add(part.id);
      run.toolCalls++;
      run.toolCounts.set(part.tool ?? "tool", (run.toolCounts.get(part.tool ?? "tool") ?? 0) + 1);
    }
  }

  const diffs = opts.includeDiff && userMessageID ? await client.diff(directory, sessionID, userMessageID).catch(() => [] as FileDiff[]) : [];
  const { summary: diffSummary, patch } = formatDiffs(diffs);

  const variant = info.variant ?? opts.labels.variant;
  const agent = info.agent ?? opts.labels.agent;
  const sections: string[] = [];
  sections.push(
    `# opencode result\n` +
      `session_id: ${sessionID}\n` +
      `model: ${modelLabel}${variant ? ` (variant ${variant})` : ""}${agent ? ` | agent ${agent}` : ""}\n` +
      `directory: ${directory}\n` +
      (run.startedAt ? `elapsed: ${elapsedLabel(run)}\n` : "") +
      `${usage}\n${toolSummary(run)}`,
  );
  if (opts.timedOut) sections.push(`## Timed out\nAborted after ${run.timeoutMs / 1000}s. Partial work may be on disk; continue with session_id ${sessionID} or inspect git diff.`);
  if (info.error) sections.push(`## opencode error\n${info.error.name}: ${JSON.stringify(info.error.data ?? {})}`);
  sections.push(`## Report\n${report ? truncate(report, env.maxReportChars, "read the full transcript with the opencode TUI") : "(opencode returned no text)"}`);
  if (opts.includeDiff) {
    sections.push(`## Changed files\n${diffSummary}`);
    if (patch) sections.push(`## Diff\n\`\`\`diff\n${truncate(patch, env.maxDiffChars, "run git diff for the rest")}\n\`\`\``);
  }

  return {
    content: [{ type: "text", text: sections.join("\n\n") }],
    isError: Boolean(info.error) || opts.timedOut,
  };
}

/** Sends the prompt and returns at once; the turn keeps running in this process until it settles or hits timeoutMs. */
function startRun(
  client: OpencodeClient,
  params: {
    sessionID: string;
    directory: string;
    task: string;
    timeoutMs: number;
    includeDiff: boolean;
    model?: { providerID: string; modelID: string };
    agent?: string;
    variant?: string;
    labels: { model?: string; agent?: string; variant?: string };
  },
): Run {
  const { sessionID, directory } = params;
  // Sessions opencode spawns for its own subagents count as ours for permission and progress purposes.
  const owned = new Set([sessionID]);
  let lastProgressAt = 0;

  const run: Run = {
    sessionID,
    directory,
    startedAt: Date.now(),
    timeoutMs: params.timeoutMs,
    toolCalls: 0,
    toolCounts: new Map(),
    seenCalls: new Set(),
    lastActivity: "",
    done: undefined as unknown as Promise<ToolResult>,
  };

  const notify = (message: string) => {
    run.lastActivity = message;
    const sink = run.sink;
    if (!sink) return;
    const now = Date.now();
    if (now - lastProgressAt < 1000) return;
    lastProgressAt = now;
    sink.send({ progressToken: sink.token, progress: run.toolCalls, message }).catch(() => {
      // caller went away; the result stays in the registry for the next wait
    });
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
        if (part.id && !run.seenCalls.has(part.id) && part.state?.status !== "pending") {
          run.seenCalls.add(part.id);
          run.toolCalls++;
          const tool = part.tool ?? "tool";
          run.toolCounts.set(tool, (run.toolCounts.get(tool) ?? 0) + 1);
        }
        if (part.state?.status === "running" || part.state?.status === "completed") notify(describeToolCall(part));
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

  run.done = (async () => {
    const watchAbort = new AbortController();
    const watching = client.watch(directory, onEvent, watchAbort.signal);
    const promptAbort = new AbortController();
    const timer = setTimeout(() => promptAbort.abort(), params.timeoutMs);
    let response: PromptResponse | undefined;
    let timedOut = false;
    let failure: unknown;
    try {
      response = await client.prompt(
        directory,
        sessionID,
        { parts: [{ type: "text", text: params.task }], model: params.model, agent: params.agent, variant: params.variant },
        promptAbort.signal,
      );
    } catch (err) {
      if (promptAbort.signal.aborted) {
        timedOut = true;
        await client.abort(directory, sessionID).catch(() => undefined);
      } else {
        failure = err;
      }
    } finally {
      clearTimeout(timer);
      watchAbort.abort();
      await watching;
    }
    let result: ToolResult;
    if (failure !== undefined) {
      const msg = failure instanceof Error ? failure.message : String(failure);
      result = { content: [{ type: "text", text: `# opencode failed\nsession_id: ${sessionID}\nelapsed: ${elapsedLabel(run)}\n\n${msg}` }], isError: true };
    } else {
      result = await buildResult(client, run, { response, timedOut, includeDiff: params.includeDiff, labels: params.labels }).catch((err) => ({
        content: [{ type: "text", text: `# opencode result unavailable\nsession_id: ${sessionID}\n\n${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      }));
    }
    run.result = result;
    return result;
  })();

  runs.set(sessionID, run);
  return run;
}

/** Resolves with the result if the run settles within waitMs, else undefined. */
async function awaitRun(run: Run, waitMs: number): Promise<ToolResult | undefined> {
  if (run.result) return run.result;
  if (waitMs <= 0) return undefined;
  return Promise.race([run.done, sleep(waitMs).then(() => undefined)]);
}

function checkSessionID(sessionID: string): void {
  if (!/^ses[A-Za-z0-9_-]+$/.test(sessionID)) {
    throw new Error(`session_id must be an opencode session id (starts with "ses"), got "${sessionID}"`);
  }
}

const waitSecondsSchema = z.number().int().min(0).max(600).optional();

server.registerTool(
  "delegate",
  {
    title: "Delegate a task to opencode",
    description: [
      "Start a task in an opencode session on a model you choose. Returns the report and diff if it finishes within wait_seconds,",
      "otherwise a running status with the session_id; the task keeps going and you collect it later with wait. Use it for",
      "heavy lifting: codebase exploration, implementation, debugging, test writing. Review the result yourself before trusting it.",
      "",
      "Big tasks: leave wait_seconds at the default, do other work, then call wait as often as needed. No task is too long for the bridge;",
      "timeout_seconds is only the hard abort for a runaway session.",
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
      wait_seconds: waitSecondsSchema.describe("How long this call waits for the task before returning a running status. Default 120, max 600. 0 returns immediately."),
      timeout_seconds: z.number().int().positive().max(7200).optional().describe("Hard abort for the opencode session, independent of wait_seconds. Default 1800."),
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
    const waitMs = (args.wait_seconds ?? 120) * 1000;
    const includeDiff = args.include_diff ?? true;

    let sessionID = args.session_id;
    if (sessionID) {
      checkSessionID(sessionID);
      const active = runs.get(sessionID);
      if (active && !active.result) throw new Error(`session ${sessionID} is still running its previous task; call wait first`);
    } else {
      const session = await client.createSession(directory, {
        title: args.title ?? args.task.slice(0, 80),
        agent,
        permission: env.autoApprove ? [{ permission: "*", pattern: "*", action: "allow" }] : undefined,
      });
      sessionID = session.id;
    }

    const run = startRun(client, {
      sessionID,
      directory,
      task: args.task,
      timeoutMs,
      includeDiff,
      model,
      agent,
      variant,
      labels: { model: args.model ?? env.defaultModel, agent, variant },
    });
    const detach = attachProgress(run, extra);
    try {
      return (await awaitRun(run, waitMs)) ?? runningResult(run, sessionID, directory);
    } finally {
      detach();
    }
  },
);

server.registerTool(
  "wait",
  {
    title: "Wait for a delegated task",
    description: [
      "Collect the result of a delegate call that returned a running status. Waits up to wait_seconds for the task to finish,",
      "then returns its report and diff, or another running status if it is still going. Call it as many times as needed.",
    ].join("\n"),
    inputSchema: {
      session_id: z.string().describe("The session_id from delegate."),
      wait_seconds: waitSecondsSchema.describe("How long to wait before returning a running status. Default 120, max 600. 0 checks without waiting."),
      directory: z.string().optional().describe("Only needed when the task was started by another bridge process. Defaults to the MCP server's working directory."),
      include_diff: z.boolean().optional().describe("Include the diff when the result has to be rebuilt from the transcript. Default true."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args, extra) => {
    checkSessionID(args.session_id);
    const client = await getClient();
    const waitMs = (args.wait_seconds ?? 120) * 1000;
    const run = runs.get(args.session_id);
    if (run) {
      const detach = attachProgress(run, extra);
      try {
        return (await awaitRun(run, waitMs)) ?? runningResult(run, run.sessionID, run.directory);
      } finally {
        detach();
      }
    }

    // Not ours (bridge restarted, or started elsewhere): poll opencode until the session goes idle, then read the transcript.
    const directory = args.directory ? path.resolve(args.directory) : env.directory;
    const deadline = Date.now() + waitMs;
    for (;;) {
      const status = await client.status(directory);
      if (!status[args.session_id]) break;
      if (Date.now() >= deadline) return runningResult(undefined, args.session_id, directory);
      await sleep(Math.min(2000, Math.max(0, deadline - Date.now())));
    }
    const orphan: Run = {
      sessionID: args.session_id,
      directory,
      startedAt: 0,
      timeoutMs: 0,
      toolCalls: 0,
      toolCounts: new Map(),
      seenCalls: new Set(),
      lastActivity: "",
      done: Promise.resolve({ content: [] }),
    };
    return buildResult(client, orphan, { timedOut: false, includeDiff: args.include_diff ?? true, labels: {} });
  },
);

server.registerTool(
  "cancel",
  {
    title: "Cancel a delegated task",
    description: "Abort a running opencode session. Work already written to disk stays; the session can be continued later with delegate.",
    inputSchema: {
      session_id: z.string().describe("The session_id from delegate."),
      directory: z.string().optional().describe("Only needed when the task was started by another bridge process."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async (args) => {
    checkSessionID(args.session_id);
    const client = await getClient();
    const run = runs.get(args.session_id);
    const directory = run?.directory ?? (args.directory ? path.resolve(args.directory) : env.directory);
    const aborted = await client.abort(directory, args.session_id);
    const text = run && !run.result
      ? `Abort sent to ${args.session_id} after ${elapsedLabel(run)}. Call wait to collect what it produced so far.`
      : `Abort sent to ${args.session_id} (opencode replied ${aborted}).`;
    return { content: [{ type: "text", text }] };
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
