# opencode-mcp

An MCP server that lets Claude Code delegate work to any model opencode can reach.

Claude stays the orchestrator: it plans, reviews and decides. opencode does the heavy lifting on a model you name per call, such as `opencode-go/deepseek-v4.1-flash` at `high` reasoning, then reports back with its summary and the diff it produced.

The bridge talks to opencode's headless HTTP server, so your opencode login, skills, `AGENTS.md`, MCP servers and permission rules all apply inside the delegated session.

## Requirements

- Node 20 or newer
- [opencode](https://opencode.ai) installed and logged in to at least one provider

## Install

```sh
git clone <this repo> ~/Projects/PERSONAL/opencode-mcp
cd ~/Projects/PERSONAL/opencode-mcp
npm install
npm run build
```

Register it with Claude Code once, for every project:

```sh
claude mcp add --scope user opencode \
  --env OPENCODE_MCP_MODEL=opencode-go/deepseek-v4.1-flash \
  -- node /home/loba/Projects/PERSONAL/opencode-mcp/dist/index.js
```

Or per project, in `.mcp.json`:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "node",
      "args": ["/home/loba/Projects/PERSONAL/opencode-mcp/dist/index.js"],
      "env": { "OPENCODE_MCP_MODEL": "opencode-go/deepseek-v4.1-flash" }
    }
  }
}
```

Restart Claude Code and check `/mcp` shows `opencode` connected.

## Use

In a Claude Code session:

```
Delegate the implementation to opencode using deepseek-v4.1-flash at high reasoning.
```

Claude calls the `delegate` tool. The result contains the session id, model, token usage, the report opencode wrote, the list of changed files and the unified diff. To send review findings back with full context:

```
Send those three review comments back to the same opencode session.
```

Claude passes the `session_id` from the earlier result.

Watch a delegated session live from another terminal with the URL from the `server_info` tool:

```sh
opencode attach http://127.0.0.1:<port>
```

## Tools

| Tool | Purpose |
| --- | --- |
| `delegate` | Run a task in an opencode session. Parameters: `task`, `model`, `variant`, `agent`, `session_id`, `directory`, `title`, `timeout_seconds`, `include_diff`. |
| `list_models` | Models opencode can use here, as `provider/model` strings, with reasoning variants. |
| `list_agents` | opencode agents. `plan` is read-only exploration, `build` may edit. |
| `server_info` | The opencode server URL and how to attach a TUI to it. |

## Configuration

All optional, set through the MCP server's `env`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENCODE_MCP_MODEL` | opencode's default | `provider/model` used when a call gives none. |
| `OPENCODE_MCP_VARIANT` | none | Default reasoning variant, e.g. `high`. |
| `OPENCODE_MCP_AGENT` | opencode's default | Default agent. |
| `OPENCODE_MCP_DIRECTORY` | server's working directory | Project directory opencode works in. |
| `OPENCODE_MCP_AUTO_APPROVE` | `1` | Approve opencode's permission prompts automatically. Set `0` to reject them instead. |
| `OPENCODE_MCP_MAX_DIFF_CHARS` | `40000` | Diff length cap in the tool result. |
| `OPENCODE_MCP_MAX_REPORT_CHARS` | `24000` | Report length cap in the tool result. |
| `OPENCODE_MCP_STARTUP_TIMEOUT_MS` | `60000` | How long to wait for `opencode serve` to come up. |
| `OPENCODE_URL` | none | Attach to an already running `opencode serve` instead of spawning one. |
| `OPENCODE_BIN` | `opencode` | Path to the opencode binary. |

Claude Code's own MCP tool timeout applies to long delegations. Raise it with `MCP_TOOL_TIMEOUT` (milliseconds) in your Claude Code environment if a task legitimately runs longer than the default.

## Orchestration guidance for Claude

Copy `claude-md-snippet.md` into the `CLAUDE.md` of projects where you want Claude to delegate by default. It tells Claude when to delegate, to verify results itself, and how many retries it gets before reporting back.

## How it works

1. On the first tool call the server spawns `opencode serve` on a free localhost port, or attaches to `OPENCODE_URL`.
2. `delegate` creates a session with an allow-all permission rule, sends the task with the requested model, agent and variant, and blocks until opencode finishes.
3. While waiting it streams opencode's events: tool calls become MCP progress notifications, permission prompts are auto-answered, and questions are rejected so opencode proceeds on its own judgment.
4. It returns the final assistant text plus the session diff. Claude reviews that, runs the tests, and decides.

## Development

```sh
npm run dev        # run from source
npm run typecheck
```
