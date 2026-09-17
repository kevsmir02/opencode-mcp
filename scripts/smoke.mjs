import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const cwd = process.argv[2];
const transport = new StdioClientTransport({
  command: "node",
  args: ["/home/loba/Projects/PERSONAL/opencode-mcp/dist/index.js"],
  cwd,
  env: { ...process.env, OPENCODE_MCP_MODEL: "opencode-go/deepseek-v4.1-flash" },
  stderr: "pipe",
});
transport.stderr?.on("data", (d) => process.stderr.write("[server] " + d));
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);
const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));
const text = (r) => r.content.map((c) => c.text).join("\n");
const call = async (name, args, onProgress) => {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { onprogress: onProgress, timeout: 15 * 60 * 1000 });
  console.log(`\n===== ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s, isError=${r.isError ?? false}) =====`);
  console.log(text(r));
  return text(r);
};
await call("server_info", {});
await call("list_agents", {});
const models = await call("list_models", {});
const progress = (p) => console.log(`  [progress ${p.progress}] ${p.message ?? ""}`);
await call("delegate", {
  task: "Explore this repository. Report: every file with a one-line purpose, and what src/math.js exports. Do not modify anything. Finish with a short report.",
  agent: "plan", variant: "high", title: "smoke explore", timeout_seconds: 300,
}, progress);
const out = await call("delegate", {
  task: "Add a function `multiply(a, b)` to src/math.js that returns a*b, exported like `add`. Then create src/math.test.js using node:test that covers add and multiply, and run it with `node --test src/`. Report what you changed and the test output.",
  variant: "high", title: "smoke implement", timeout_seconds: 600,
}, progress);
const sid = /session_id: (\S+)/.exec(out)?.[1];
if (sid) await call("delegate", {
  task: "Follow-up in the same session: also add a `subtract(a, b)` export and a test for it, then rerun the tests. Report briefly.",
  session_id: sid, variant: "high", timeout_seconds: 600,
}, progress);
await client.close();
