import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// Usage: node scripts/smoke-async.mjs <scratch project dir>. Set OPENCODE_URL to reuse a running opencode server.
const cwd = process.argv[2];
const transport = new StdioClientTransport({
  command: "node",
  args: ["/home/loba/Projects/PERSONAL/opencode-mcp/dist/index.js"],
  cwd,
  env: { ...process.env, OPENCODE_MCP_MODEL: "opencode-go/deepseek-v4.1-flash" },
  stderr: "pipe",
});
transport.stderr?.on("data", (d) => process.stderr.write("[server] " + d));
const client = new Client({ name: "async-smoke", version: "0.0.0" });
await client.connect(transport);
const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));
const text = (r) => r.content.map((c) => c.text).join("\n");
const progress = (p) => console.log(`  [progress ${p.progress}] ${p.message ?? ""}`);
const call = async (name, args) => {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { onprogress: progress, timeout: 15 * 60 * 1000 });
  console.log(`\n===== ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s, isError=${r.isError ?? false}) =====`);
  console.log(text(r).slice(0, 1800));
  return text(r);
};

// 1. delegate with wait 0 must come back at once with a running status
const started = await call("delegate", {
  task: "Add a function `multiply(a, b)` to src/math.js that returns a*b, exported like `add`. Then create src/math.test.js using node:test covering add and multiply, and run it with `node --test src/`. Report what you changed and the test output.",
  title: "async smoke implement", wait_seconds: 0, timeout_seconds: 600,
});
const sid = /session_id: (\S+)/.exec(started)?.[1];
if (!/# opencode running/.test(started)) throw new Error("expected running status");

// 2. wait 0 is a pure status check
await call("wait", { session_id: sid, wait_seconds: 0 });

// 3. busy session must be refused a second prompt
await client.callTool({ name: "delegate", arguments: { task: "x", session_id: sid, wait_seconds: 0 } }).then((r) => {
  console.log("\n===== delegate on busy session =====\nisError:", r.isError, text(r).slice(0, 200));
});

// 4. poll until done
let out;
for (let i = 0; i < 20; i++) {
  out = await call("wait", { session_id: sid, wait_seconds: 20 });
  if (/# opencode result/.test(out)) break;
}
if (!/# opencode result/.test(out)) throw new Error("never finished");
// 5. cached result comes back again instantly
const again = await call("wait", { session_id: sid, wait_seconds: 0 });
if (again !== out) throw new Error("cached result differs");

// 6. cancel: start a long task, cancel it, collect partial result
const long = await call("delegate", {
  task: "Write a 3000 word essay about the history of arithmetic into ESSAY.md, one paragraph per edit call, at least twelve edits. Report when done.",
  title: "async smoke cancel", wait_seconds: 5, timeout_seconds: 600,
});
const sid2 = /session_id: (\S+)/.exec(long)?.[1];
if (/# opencode running/.test(long)) {
  await call("cancel", { session_id: sid2 });
  await call("wait", { session_id: sid2, wait_seconds: 30 });
}

// 7. fallback path: a fresh bridge process that never saw sid must still rebuild the result
await client.close();
const t2 = new StdioClientTransport({ command: "node", args: ["/home/loba/Projects/PERSONAL/opencode-mcp/dist/index.js"], cwd, env: { ...process.env }, stderr: "pipe" });
const c2 = new Client({ name: "async-smoke-2", version: "0.0.0" });
await c2.connect(t2);
const r = await c2.callTool({ name: "wait", arguments: { session_id: sid, wait_seconds: 10 } });
console.log(`\n===== wait from fresh process (isError=${r.isError ?? false}) =====\n` + text(r).slice(0, 1200));
if (!/# opencode result/.test(text(r))) throw new Error("fallback failed");
await c2.close();
console.log("\nALL CHECKS PASSED");
