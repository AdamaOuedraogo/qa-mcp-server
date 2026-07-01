# qa-mcp-server

A small, safe [Model Context Protocol (MCP)](https://modelcontextprotocol.io)
server for **Quality Engineering**. It gives an AI assistant a few narrow,
typed tools to work with QA workflows — Playwright, Cypress, and test reports —
**without ever handing it a shell**.

> Status: **v0.1 — foundation.** A clean, extensible MVP. See the [roadmap](ROADMAP.md).

## Why this exists

AI assistants are increasingly asked to help with testing: writing specs,
running suites, reading failures. Doing that usually means giving the model a
generic terminal — which is powerful and unsafe.

This server takes the opposite approach. It exposes QA capabilities as
**controlled tools** with typed inputs, so an assistant can help with testing
through a small, predictable, auditable surface instead of arbitrary commands.

## What it exposes

**Tools**

| Tool | What it does | Inputs |
| --- | --- | --- |
| `run_playwright_test` | Builds the Playwright command that would run. | `testPath?`, `headed?`, `project?` |
| `run_cypress_test` | Builds the Cypress command that would run. | `spec?`, `browser?` |
| `read_test_report` | Reads a report file from disk, size-capped. | `reportPath?` |

**Resources**

- `qa://test-strategy` — a pragmatic, layered test strategy (Markdown).
- `qa://playwright-guidelines` — conventions for reliable Playwright tests.

**Prompts**

- `generate-playwright-test` — turn a user story + conventions into a spec.
- `analyze-test-failure` — triage a failure from report, trace, and logs.

## Safe by design

This is a deliberate MVP, not a limitation to work around:

- **No generic terminal.** There is no "run any command" tool.
- **Dry-run by default.** `run_playwright_test` and `run_cypress_test` return
  the exact command they *would* run — they do not execute anything. That makes
  the server safe to connect anywhere. Real execution is planned as an explicit
  opt-in (see the [roadmap](ROADMAP.md)).
- **No shell, ever.** The command utility runs binaries with an argument array
  and `shell: false`, against an allowlist (`npx`, `pnpm`, `node`).
- **Sanitized inputs.** Control characters are stripped from tool arguments.
- **Bounded reads.** `read_test_report` truncates large files.

## Install & run

Requirements: **Node.js ≥ 18** and **pnpm**.

```bash
pnpm install
pnpm dev        # run over stdio (via tsx, no build step)
```

Or build and run the compiled server:

```bash
pnpm build && pnpm start
pnpm typecheck  # type-check only
```

On startup you'll see `qa-mcp-server running on stdio` on **stderr** (stdout is
reserved for the MCP protocol stream).

## Try it with MCP Inspector

The quickest way to explore the server is the official
[MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
pnpm build
npx @modelcontextprotocol/inspector node dist/index.js
```

It opens a local web UI. From there you can:

1. **Tools** → call `run_playwright_test` with e.g. `testPath: "tests/login.spec.ts"`,
   `project: "chromium"`, `headed: true`, and see the command it would run.
2. **Resources** → read `qa://test-strategy` and `qa://playwright-guidelines`.
3. **Prompts** → render `generate-playwright-test` with a sample user story.

## Connect to an MCP client

Most clients launch a local server as a subprocess. Point yours at the built
entry point after `pnpm build`:

```json
{
  "mcpServers": {
    "qa": {
      "command": "node",
      "args": ["/absolute/path/to/qa-mcp-server/dist/index.js"]
    }
  }
}
```

## Docs

- [Vision](docs/vision.md) · [Architecture](docs/architecture.md) · [Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE) © 2026 Adama Ouedraogo
