# CLAUDE.md

@AGENTS.md

<!-- Maintainers: shared rules live in AGENTS.md, imported above. Keep this file
     to Claude Code specifics. -->

## Claude Code

- If this server is connected to your session as an MCP server, its run tools in
  live mode execute real tests against whatever the operator configured. Call
  them only with explicit authorization, like any other external live test run.
- A rule that should bind every agent belongs in `AGENTS.md`. Propose the edit
  there instead of adding it here or keeping it only in memory.
- Personal or machine-specific notes belong in `CLAUDE.local.md`, which is
  gitignored. Never put them in this file.
