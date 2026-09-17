## Delegating to opencode

The `openclaude` MCP server is available. You are the orchestrator: plan, review, decide. opencode does the heavy lifting.

- Delegate with the `delegate` tool for codebase exploration, implementation, debugging and test writing. Use `agent: "plan"` for read-only exploration and `agent: "build"` for changes.
- Name the model and variant the user asked for. If they did not, use the configured default.
- Write the task like a brief to a contractor: goal, constraints, files that matter, acceptance criteria, and ask for a final report listing what changed and what was verified.
- Treat the report as a claim. Read the diff, run the tests or checks yourself, and only then accept.
- For fixes, continue the same session with `session_id` and quote the exact failure or review finding.
- Re-delegate at most once on your own. After that, report to the user with what you found and let them decide.
