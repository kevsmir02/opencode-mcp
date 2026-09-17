import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";

export type Json = Record<string, unknown>;

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface FileDiff {
  file?: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified";
}

export interface Session {
  id: string;
  title?: string;
  parentID?: string;
  directory?: string;
  cost?: number;
  tokens?: TokenUsage;
  summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
}

export interface ToolState {
  status: "pending" | "running" | "completed" | "error";
  input?: Json;
  title?: string;
  output?: string;
  error?: string;
}

export interface Part {
  id?: string;
  sessionID?: string;
  type: string;
  text?: string;
  synthetic?: boolean;
  tool?: string;
  state?: ToolState;
}

export interface AssistantMessage {
  id: string;
  sessionID: string;
  role: "assistant";
  error?: { name: string; data?: Json };
  /** The user message this turn answers; opencode keys per-turn diffs on it. */
  parentID?: string;
  modelID?: string;
  providerID?: string;
  agent?: string;
  variant?: string;
  cost?: number;
  tokens?: TokenUsage;
  finish?: string;
  time: { created: number; completed?: number };
}

export interface PromptResponse {
  info: AssistantMessage;
  parts: Part[];
}

export interface UserMessage {
  id: string;
  sessionID: string;
  role: "user";
  time: { created: number };
}

export interface Message {
  info: UserMessage | AssistantMessage;
  parts: Part[];
}

export interface Agent {
  name: string;
  mode: "subagent" | "primary" | "all";
  hidden?: boolean;
  native?: boolean;
  model?: { providerID: string; modelID: string };
  variant?: string;
}

export interface Model {
  id: string;
  providerID: string;
  name?: string;
  capabilities?: { reasoning?: boolean };
  variants?: Record<string, Json>;
  status?: string;
}

export interface Provider {
  id: string;
  name: string;
  source: string;
  models: Record<string, Model>;
}

export interface ProviderList {
  all: Provider[];
  default?: Record<string, string>;
  connected?: string[];
}

export interface OpencodeEvent {
  type: string;
  properties: Json;
}

export interface ConnectOptions {
  url?: string;
  binary: string;
  cwd: string;
  startupTimeoutMs: number;
  log: (line: string) => void;
}

export class OpencodeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "OpencodeError";
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => {
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("could not allocate a port"));
      });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class OpencodeClient {
  private constructor(
    readonly baseUrl: string,
    readonly managed: boolean,
    private proc?: ChildProcess,
  ) {}

  /** Attach to `url` when given, otherwise spawn `opencode serve` on a free port. */
  static async connect(opts: ConnectOptions): Promise<OpencodeClient> {
    if (opts.url) {
      const client = new OpencodeClient(opts.url.replace(/\/$/, ""), false);
      await client.waitReady(opts.startupTimeoutMs);
      return client;
    }

    const port = await freePort();
    const proc = spawn(opts.binary, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    for (const stream of [proc.stdout, proc.stderr]) {
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => {
        for (const line of chunk.split("\n")) if (line.trim()) opts.log(`[opencode] ${line}`);
      });
    }
    const exited = new Promise<never>((_, reject) => {
      proc.once("exit", (code, signal) =>
        reject(new OpencodeError(`opencode serve exited during startup (code ${code}, signal ${signal})`)),
      );
      proc.once("error", (err) => reject(new OpencodeError(`could not start ${opts.binary}: ${err.message}`)));
    });

    const client = new OpencodeClient(`http://127.0.0.1:${port}`, true, proc);
    try {
      await Promise.race([client.waitReady(opts.startupTimeoutMs), exited]);
    } catch (err) {
      client.close();
      throw err;
    }
    return client;
  }

  private async waitReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        // A fresh server can accept the socket and then sit in project bootstrap; bound each probe so one
        // stalled request cannot eat the whole budget (undici would otherwise wait 300s).
        await this.request("GET", "/agent", { signal: AbortSignal.timeout(3000) });
        return;
      } catch (err) {
        lastErr = err;
        await sleep(250);
      }
    }
    throw new OpencodeError(`opencode server at ${this.baseUrl} not ready after ${timeoutMs}ms: ${String(lastErr)}`);
  }

  close(): void {
    if (this.proc && !this.proc.killed) this.proc.kill("SIGTERM");
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | undefined>; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new OpencodeError(`${method} ${path} -> ${res.status}: ${text.slice(0, 2000)}`, res.status);
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  createSession(directory: string, body: { title?: string; agent?: string; permission?: { permission: string; pattern: string; action: "allow" | "deny" | "ask" }[] }): Promise<Session> {
    return this.request<Session>("POST", "/session", { query: { directory }, body });
  }

  getSession(directory: string, sessionID: string): Promise<Session> {
    return this.request<Session>("GET", `/session/${encodeURIComponent(sessionID)}`, { query: { directory } });
  }

  /** Blocks until opencode finishes the turn; returns the assistant message it produced. */
  prompt(
    directory: string,
    sessionID: string,
    body: {
      parts: { type: "text"; text: string }[];
      model?: { providerID: string; modelID: string };
      agent?: string;
      variant?: string;
      system?: string;
    },
    signal?: AbortSignal,
  ): Promise<PromptResponse> {
    return this.request<PromptResponse>("POST", `/session/${encodeURIComponent(sessionID)}/message`, { query: { directory }, body, signal });
  }

  messages(directory: string, sessionID: string): Promise<Message[]> {
    return this.request<Message[]>("GET", `/session/${encodeURIComponent(sessionID)}/message`, { query: { directory } });
  }

  /** Without messageID opencode returns the session-wide diff, which is empty for headless sessions; pass the user message id. */
  diff(directory: string, sessionID: string, messageID?: string): Promise<FileDiff[]> {
    return this.request<FileDiff[]>("GET", `/session/${encodeURIComponent(sessionID)}/diff`, { query: { directory, messageID } });
  }

  /** Busy sessions keyed by id; idle sessions are absent. */
  status(directory: string): Promise<Record<string, { type: string }>> {
    return this.request<Record<string, { type: string }>>("GET", "/session/status", { query: { directory } });
  }

  abort(directory: string, sessionID: string): Promise<boolean> {
    return this.request<boolean>("POST", `/session/${encodeURIComponent(sessionID)}/abort`, { query: { directory } });
  }

  agents(directory: string): Promise<Agent[]> {
    return this.request<Agent[]>("GET", "/agent", { query: { directory } });
  }

  providers(directory: string): Promise<ProviderList> {
    return this.request<ProviderList>("GET", "/provider", { query: { directory } });
  }

  replyPermission(directory: string, sessionID: string, permissionID: string, response: "once" | "always" | "reject"): Promise<boolean> {
    return this.request<boolean>("POST", `/session/${encodeURIComponent(sessionID)}/permissions/${encodeURIComponent(permissionID)}`, { query: { directory }, body: { response } });
  }

  rejectQuestion(directory: string, requestID: string): Promise<unknown> {
    return this.request("POST", `/question/${encodeURIComponent(requestID)}/reject`, { query: { directory } });
  }

  /** Streams server-sent events until `signal` aborts. Resolves (never rejects) when the stream ends. */
  async watch(directory: string, onEvent: (event: OpencodeEvent) => void, signal: AbortSignal): Promise<void> {
    const url = new URL(this.baseUrl + "/event");
    url.searchParams.set("directory", directory);
    try {
      const res = await fetch(url, { headers: { accept: "text/event-stream" }, signal });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("\n");
          if (!data) continue;
          try {
            onEvent(JSON.parse(data) as OpencodeEvent);
          } catch {
            // opencode also sends keep-alive frames that are not JSON
          }
        }
      }
    } catch {
      // aborted by caller or connection dropped; the prompt call is the source of truth
    }
  }
}
