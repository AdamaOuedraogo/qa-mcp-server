# QA MCP Server

> **Give an AI agent the QA lead's job — with method, guardrails and a trace.**

`qa-mcp-server` is an open-source Model Context Protocol (MCP) server that exposes Quality Engineering as typed, testable capabilities: judgments with evidence, not raw data.

Writing code is no longer the slow part of shipping software; knowing whether it holds is. This project exists to keep quality from becoming the bottleneck. It models the work of an experienced quality engineer — define a test strategy, set quality gates, generate and run tests, judge flaky failures and release readiness, investigate incidents — and makes that work available to any agent harness through MCP.

It starts small and safe: running Playwright and Cypress, reading reports, triaging flaky tests. Those are execution details. The first-class inputs of Quality Engineering are requirements, tickets, source code, merge requests, incidents and business rules, and the direction is the full job built on four shared primitives: a journal of runs, an approval gate, evals of the server's own judgment, and delegation contracts.

> **Not a replacement for QA engineers: a multiplier of their judgment.**

---

## Contents

* [Why this project exists](#why-this-project-exists)
* [Current MVP](#current-mvp)
* [Getting Started](#getting-started)
* [Connect it to your project](#connect-it-to-your-project)
* [Real execution (opt-in)](#real-execution-opt-in)
* [Architecture](#architecture)
* [Why walls, not a terminal ban](#why-walls-not-a-terminal-ban)
* [Core Design Principles](#core-design-principles)
* [Roadmap](#roadmap)
* [Vision](#vision)
* [Contributing](#contributing)
* [Documentation](#documentation)
* [License](#license)

---

# Why this project exists

AI assistants generate features, fix bugs and open pull requests in minutes. What has not sped up is verification: is the requirement met, does the change break something else, is the release safe, is this incident a real bug.

A team that ships ten times faster without ten times more verification accumulates invisible debt until an incident makes it visible. The test pyramid, test-driven development and quality gates are what make speed sustainable.

An AI agent can carry that work, on one condition: it must receive three things nobody gives it by default.

1. **A method** — how to prioritize, how to judge a flaky test, when a release is ready. Expertise as explicit rules, not the model's mood.
2. **Deterministic guardrails** — what the agent may never do on its own, whatever it is told. Enforced in code, not in a prompt.
3. **A trace** — every judgment with its evidence, every run with a receipt. Observable, replayable, evaluable.

Not more intelligence. Method, limits and memory. See the full [Vision](docs/vision.md).

---

# Current MVP

The MVP is intentionally small: low-level, safe testing capabilities plus one
judgment capability. The QA lead's capabilities such as `validate_ticket`,
`review_merge_request` and `investigate_incident` are **long-term targets, not
current features** — they will be built on the primitives described in the
[roadmap](ROADMAP.md). See also [Vision](#vision).

## Tools

| Tool                | Purpose                        | Status                                          |
| ------------------- | ------------------------------ | ----------------------------------------------- |
| run_playwright_test | Prepare a Playwright test run  | **Dry-run** — returns the command, does not run it |
| run_cypress_test    | Prepare a Cypress test run     | **Dry-run** — returns the command, does not run it |
| read_test_report    | Read a test report file safely | Active — reads from disk, size-capped           |
| triage_flaky_test   | Judge a failure: flaky (infrastructure, race, data), test error, likely regression or inconclusive, with evidence | Active — pure, deterministic, no process started |

> **Dry-run by design.** By default the run tools return the exact command they
> *would* execute, without executing anything, so the server is safe to connect
> anywhere. Real execution is available as an explicit opt-in — see
> [Real execution](#real-execution-opt-in).

---

## Resources

| Resource                   | Purpose                   |
| -------------------------- | ------------------------- |
| qa://test-strategy         | Testing strategy          |
| qa://playwright-guidelines | Playwright best practices |

---

## Prompts

| Prompt                   | Purpose                                        |
| ------------------------ | ---------------------------------------------- |
| generate-playwright-test | Generate Playwright tests from requirements    |
| analyze-test-failure     | Analyze test failures using available evidence |
| flaky-test-triage        | Guide a flaky-test triage with `triage_flaky_test` |

---

# Getting Started

Requirements: **Node.js ≥ 18** and **pnpm**.

## Install

```bash
pnpm install
```

## Run

```bash
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

It opens a local web UI where you can:

1. **Tools** → call `run_playwright_test` with e.g. `testPath: "tests/login.spec.ts"`,
   `project: "chromium"`, `headed: true`, and see the command it would run.
2. **Resources** → read `qa://test-strategy` and `qa://playwright-guidelines`.
3. **Prompts** → render `generate-playwright-test` with a sample user story.

## Connect it to your project

To run a real project's tests and use the QA capabilities from your MCP client,
point the server at that project. There are two ways to wire it up — pick one:

- **Method A — project-scoped `.mcp.json`** (recommended, versionable): drop a
  `.mcp.json` at the root of the project you want to test.

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

- **Method B — CLI / client config**: register it directly, e.g. with Claude Code:

  ```bash
  cd /absolute/path/to/your/test-project
  claude mcp add qa -s project \
    --env QA_MCP_EXECUTION_MODE=live \
    --env QA_MCP_PROJECT_DIR=/absolute/path/to/your/test-project \
    -- node /absolute/path/to/qa-mcp-server/dist/index.js
  ```

`QA_MCP_PROJECT_DIR` must be the directory that holds the test config
(`playwright.config.ts`, `cypress.config.ts`, …) — if tests live in a `testing/`
subfolder, point at that subfolder, not the repo root.

Full step-by-step (Claude Desktop config, verification, flaky-triage usage, and
safety notes) is in **[Connect to a project](docs/connect-to-a-project.md)**.

## Real execution (opt-in)

By default the run tools are **dry-run** and execute nothing. Real execution is
an explicit opt-in, controlled entirely by environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `QA_MCP_EXECUTION_MODE` | `dry-run` or `live` | `dry-run` |
| `QA_MCP_PROJECT_DIR` | Absolute path of the **only** directory tests may run in | — |
| `QA_MCP_EXEC_TIMEOUT_MS` | Max run time before the process is killed | `600000` |
| `QA_MCP_BASE_URL_LOCAL` / `_STAGING` / `_PREPROD` / `_PRODUCTION` | Base URL per target environment (see below) | — |

Live execution runs only when **both** `QA_MCP_EXECUTION_MODE=live` **and**
`QA_MCP_PROJECT_DIR` are set. Runs are pinned to that directory, arguments
containing `..` are rejected, and execution goes through a single
[execution adapter](docs/architecture.md#execution-model) that reuses the
allowlisted, no-shell command helper.

Example MCP client config pointing at a real Cypress project:

```json
{
  "mcpServers": {
    "qa": {
      "command": "node",
      "args": ["/absolute/path/to/qa-mcp-server/dist/index.js"],
      "env": {
        "QA_MCP_EXECUTION_MODE": "live",
        "QA_MCP_PROJECT_DIR": "/absolute/path/to/your/cypress-project"
      }
    }
  }
}
```

With this set, calling `run_cypress_test` with
`spec: "cypress/e2e/user/login.spec.cy.ts"` actually runs
`npx cypress run --spec ...` in the project and returns the run status, exit
code, and captured output (including failures).

### Target environments

Both run tools accept an optional `environment` — a **closed enum**:
`local` | `staging` | `preprod` | `production`. The caller can *select* an
environment but can never define what it points to:

- The name maps to an operator-provided base URL (`QA_MCP_BASE_URL_<ENV>`),
  injected as `CYPRESS_BASE_URL` / `PLAYWRIGHT_BASE_URL` — passed to the process
  as an environment variable, never interpolated into the command string.
- For Cypress, the name is also passed as `--env target=<environment>` so the
  project can branch on it (`Cypress.env("target")`).
- If no base URL is configured for that environment, the tool falls back to the
  project's own defaults instead of guessing.

Because `environment` is validated against the enum, arbitrary values (e.g. an
injected URL or shell fragment) are rejected before the handler runs.

### Non-default project layouts

Real projects don't always use the default command shape. A Cypress project may
keep its config in a custom file, require `--e2e`, or read project-specific
environment variables; a Playwright project may use a non-default config file.
So the server can plug into **any** project, these details are supplied by the
**operator** (never the caller) through environment variables:

| Variable | Effect |
| --- | --- |
| `QA_MCP_CYPRESS_CONFIG_FILE` | Adds `--config-file <path>` |
| `QA_MCP_CYPRESS_E2E` | Adds `--e2e` when truthy (`1`/`true`/`yes`/`on`) |
| `QA_MCP_CYPRESS_PROJECT` | Injects `PROJECT=<value>` into the child env |
| `QA_MCP_CYPRESS_ENV_VAR` | Injects the **selected** environment name into this env var (e.g. `ENVIRONMENT`) |
| `QA_MCP_PLAYWRIGHT_CONFIG_FILE` | Adds `--config <path>` |

The caller still only picks typed parameters and closed enums; these values are
passed as discrete argv entries or child env, never interpolated into a shell
string. See [Connect to a project](docs/connect-to-a-project.md) for a worked
example (a Cucumber/hybrid Cypress project).

---

# Architecture

The server acts as a controlled bridge between an AI assistant and the Quality Engineering ecosystem.

---

# Why walls, not a terminal ban

Early versions of this project were framed as "no terminal for the AI". The real point is narrower: an agent may have a whole machine when that machine has walls.

This server never exposes a generic shell to the model, because a QA capability does not need one. But the same design works when the agent runs in a sandbox with a full shell: an egress allowlist, a pinned working directory, an approval gate for sensitive actions. The walls are what make agent behaviour:

* easier to understand;
* easier to audit;
* easier to secure;
* easier to extend.

Every capability is explicitly designed, reviewed and documented; every sensitive action is gated in code, not in a prompt.

---

# Core Design Principles

## Purpose-built capabilities

An AI assistant should receive dedicated Quality Engineering capabilities instead of unrestricted operating system access.

## Safe by default

Potentially dangerous operations should require explicit design and validation.

The safest behaviour should always be the default behaviour.

## Small building blocks

Each Tool, Resource and Prompt should remain independent, understandable and easy to extend.

## Documentation first

Architecture decisions should be documented before features become complex.

## AI-friendly interfaces

Everything exposed by this server should be designed for both humans and AI assistants.

---

# Roadmap

The project evolves incrementally, in the order the dependencies impose: you cannot evaluate what you do not observe, nor gate what you do not journal.

- **v0.1 — Foundation**: tools, resources, prompts, safe execution utility. Done.
- **v0.2 — Real execution (opt-in)**: live runs pinned to one project directory. Done; structured results and execution-boundary tests still open.
- **v0.3 — Primitives**: journal and receipts, approval gate, evals, delegation.
- **v0.4 — The QA lead's capabilities**: `define_test_strategy`, `assess_release`, `validate_ticket`, `review_merge_request`, `investigate_incident`, built on the primitives.

Details, non-goals and the three-layer design are in [ROADMAP.md](ROADMAP.md).

---

# Vision

Quality is becoming the bottleneck of software delivery. This project gives agents the job of a QA lead — strategy, gates, tests, judgment, investigation — with the method, the guardrails and the trace that let a company trust them with its releases.

The server is one layer in a three-layer design, and the only one this repository owns: capabilities and primitives live here; the QA method lives in skills and agent instructions; orchestration (which agent does what, where) belongs to the harness you already use. Keeping orchestration out of the server is deliberate: harnesses improve every few months, and a capability server benefits from every improvement.

The repository keeps two roles: a useful server, and a living laboratory for agentic quality engineering, where every concept is built here before being written about.

→ Read the full [Vision document](docs/vision.md).

---

# Contributing

Contributions are welcome.

If you have ideas for QA workflows that could help AI assistants become better Quality Engineers, feel free to open an issue or submit a pull request.

---

# Documentation

More detail lives in the dedicated documents:

* [Vision](docs/vision.md) — project philosophy and Agentic Quality Engineering
* [Connect to a project](docs/connect-to-a-project.md) — wire the server to a real test project (both methods)
* [Architecture](docs/architecture.md) — how tools, resources and prompts are wired
* [Roadmap](ROADMAP.md) — planned evolution and non-goals
* [Contributing](CONTRIBUTING.md) — how to propose QA workflows and changes

---

# License

MIT © 2026 Adama Ouedraogo
