# Connect qa-mcp-server to a project

This guide shows how to point `qa-mcp-server` at a real test project so an MCP
client (Claude Code, Claude Desktop, an IDE extension…) can run its tests and
use the QA capabilities (e.g. `triage_flaky_test`).

The server itself never lives inside your app. It runs as a separate process and
is pinned to **one** project directory through environment variables. Nothing is
executed unless you explicitly opt in to live execution.

## Prerequisites

- **Node.js ≥ 18**.
- A built server: from the `qa-mcp-server` repo, run `pnpm install && pnpm build`.
  The entry point is then `dist/index.js`.
- A **test project** with a Playwright and/or Cypress setup. `QA_MCP_PROJECT_DIR`
  must be the directory that actually holds the test config
  (`playwright.config.ts`, `cypress.config.ts`, …) — not necessarily the app
  root. If tests live in a `testing/` subfolder, point at that subfolder.

## Two things to configure

1. **Connection** — how your MCP client launches the server (two methods below).
2. **Execution mode** — `dry-run` (default, executes nothing) or `live` (runs
   the real test command inside `QA_MCP_PROJECT_DIR`).

### Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `QA_MCP_EXECUTION_MODE` | `dry-run` or `live` | `dry-run` |
| `QA_MCP_PROJECT_DIR` | Absolute path of the **only** directory tests may run in | — |
| `QA_MCP_EXEC_TIMEOUT_MS` | Max run time before the process is killed | `600000` |
| `QA_MCP_BASE_URL_LOCAL` / `_STAGING` / `_PREPROD` / `_PRODUCTION` | Base URL per target environment | — |

Live execution runs **only** when both `QA_MCP_EXECUTION_MODE=live` and
`QA_MCP_PROJECT_DIR` are set. Otherwise the run tools stay in dry-run and simply
return the exact command they *would* run — safe to connect anywhere.

### Non-default project layouts (operator variables)

The run tools default to a plain `cypress run` / `playwright test`. If your
project needs more — a custom config file, Cypress `--e2e`, or project-specific
env vars — declare it once, as the operator, through these variables. The caller
(the model) never sees them and still only picks typed parameters.

| Variable | Effect |
| --- | --- |
| `QA_MCP_CYPRESS_CONFIG_FILE` | Adds `--config-file <path>` |
| `QA_MCP_CYPRESS_E2E` | Adds `--e2e` when truthy (`1`/`true`/`yes`/`on`) |
| `QA_MCP_CYPRESS_PROJECT` | Injects `PROJECT=<value>` into the child env |
| `QA_MCP_CYPRESS_ENV_VAR` | Injects the **selected** environment name into this env var (e.g. `ENVIRONMENT`) |
| `QA_MCP_PLAYWRIGHT_CONFIG_FILE` | Adds `--config <path>` |

Paths are relative to `QA_MCP_PROJECT_DIR`; `..` is rejected.

---

## Method A — Project-scoped `.mcp.json` (recommended)

Create a `.mcp.json` at the **root of the project you want to test**. It is
versionable and travels with the repo, so anyone opening it in an MCP client
gets the same QA server.

```json
{
  "mcpServers": {
    "qa": {
      "command": "node",
      "args": ["/absolute/path/to/qa-mcp-server/dist/index.js"],
      "env": {
        "QA_MCP_EXECUTION_MODE": "live",
        "QA_MCP_PROJECT_DIR": "/absolute/path/to/your/test-project",
        "QA_MCP_BASE_URL_LOCAL": "http://localhost:3000"
      }
    }
  }
}
```

Open the project in your MCP client, approve the server the first time, then
verify it is connected (in Claude Code: `/mcp`).

## Method B — CLI / client config

If you prefer not to commit a file, register the server directly with your
client.

**Claude Code CLI** (creates or updates the project config for you):

```bash
cd /absolute/path/to/your/test-project
claude mcp add qa -s project \
  --env QA_MCP_EXECUTION_MODE=live \
  --env QA_MCP_PROJECT_DIR=/absolute/path/to/your/test-project \
  --env QA_MCP_BASE_URL_LOCAL=http://localhost:3000 \
  -- node /absolute/path/to/qa-mcp-server/dist/index.js
```

Use `-s user` instead of `-s project` to make the server available in every
project rather than just this one.

**Claude Desktop** — add the same block to its config file
(`claude_desktop_config.json`), under `mcpServers`, then restart the app:

```json
{
  "mcpServers": {
    "qa": {
      "command": "node",
      "args": ["/absolute/path/to/qa-mcp-server/dist/index.js"],
      "env": {
        "QA_MCP_EXECUTION_MODE": "live",
        "QA_MCP_PROJECT_DIR": "/absolute/path/to/your/test-project"
      }
    }
  }
}
```

---

## Verify and use

1. Confirm the server is connected and its tools are listed (`/mcp` in Claude
   Code).
2. **Run tests** — ask the agent to run Playwright or Cypress; it calls
   `run_playwright_test` / `run_cypress_test`, which execute inside
   `QA_MCP_PROJECT_DIR`. Start with `dry-run` to see the exact command, then
   switch to `live`.
3. **Triage a flaky failure** — when a test fails or is retried, ask whether it
   is flaky or a real regression. The agent feeds the test's attempts (and
   history, if tracked) to `triage_flaky_test`, which returns a QA judgment:
   classification, confidence, evidence, prioritized actions, and whether
   quarantine is allowed.

> `triage_flaky_test` does **not** run tests — it is a judgment capability. It
> reasons over the attempts/history the agent gives it. Use the run tools to
> produce those results, then triage them.

## Example: a project with tests in a subfolder

Given an app whose Playwright + Cypress setup lives under `testing/`, point the
server at that subfolder, not the repo root:

```json
{
  "mcpServers": {
    "qa": {
      "command": "node",
      "args": ["/absolute/path/to/qa-mcp-server/dist/index.js"],
      "env": {
        "QA_MCP_EXECUTION_MODE": "live",
        "QA_MCP_PROJECT_DIR": "/absolute/path/to/your-app/testing",
        "QA_MCP_BASE_URL_LOCAL": "http://localhost:3000"
      }
    }
  }
}
```

## Example: a Cucumber/hybrid Cypress project

Some Cypress projects don't keep `cypress.config.ts` at the root — they load a
custom config and resolve settings from `PROJECT` / `ENVIRONMENT` env vars (a
common Cucumber/hybrid pattern). Wire it up entirely through operator variables:

```json
{
  "mcpServers": {
    "qa": {
      "command": "node",
      "args": ["/absolute/path/to/qa-mcp-server/dist/index.js"],
      "env": {
        "QA_MCP_EXECUTION_MODE": "live",
        "QA_MCP_PROJECT_DIR": "/absolute/path/to/your-app/testing",
        "QA_MCP_CYPRESS_CONFIG_FILE": "./cypress/configs/hybrid.config.ts",
        "QA_MCP_CYPRESS_E2E": "true",
        "QA_MCP_CYPRESS_PROJECT": "hybrid",
        "QA_MCP_CYPRESS_ENV_VAR": "ENVIRONMENT",
        "QA_MCP_BASE_URL_STAGING": "http://localhost:3210"
      }
    }
  }
}
```

Calling `run_cypress_test` with `browser: "chrome"`, `environment: "staging"`
then produces:

```
npx cypress run --browser chrome --e2e --config-file ./cypress/configs/hybrid.config.ts --env target=staging
# child env: PROJECT=hybrid ENVIRONMENT=staging CYPRESS_BASE_URL=http://localhost:3210
```

which matches the project's own `cypress run --e2e --config-file …` script.

## Safety notes

- Runs are pinned to `QA_MCP_PROJECT_DIR`; arguments containing `..` are
  rejected and there is no generic shell tool.
- `environment` is a closed enum (`local` | `staging` | `preprod` |
  `production`); the caller can select one but never define its URL.
- Keep `production` base URLs out of committed `.mcp.json` files — set them in
  client/user config instead.
