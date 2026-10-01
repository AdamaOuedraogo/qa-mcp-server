# AGENTS.md

Instructions for coding agents working in this repository. Human contributors
should start with [CONTRIBUTING.md](CONTRIBUTING.md).

## Purpose

`qa-mcp-server` is an MCP server that exposes small, safe, composable Quality
Engineering capabilities as typed tools, resources, and prompts. It never
exposes a generic terminal. Capabilities come before frameworks or
orchestration: do not add agent frameworks, workflow engines, or abstraction
layers until repeated, real needs justify them.

## Read first

Link to these documents; do not copy them.

- [README.md](README.md): public surface and configuration variables
- [docs/vision.md](docs/vision.md): philosophy and the feature decision rule
- [docs/architecture.md](docs/architecture.md): register-function pattern, security model
- [docs/connect-to-a-project.md](docs/connect-to-a-project.md): operator setup and execution modes
- [ROADMAP.md](ROADMAP.md): direction and explicit non-goals
- [CONTRIBUTING.md](CONTRIBUTING.md): contribution principles
- [Flaky-test triage README](src/capabilities/flaky-test-triage/README.md) and its
  [reasoning spec](src/capabilities/flaky-test-triage/docs/reasoning.md)

Use code and tests to establish current implemented behavior. Use documentation
to understand intended behavior. Flag discrepancies; do not assume the
implementation is correct or silently change product intent.

## Architecture map

```text
src/index.ts              stdio entry point; diagnostics go to stderr
src/server.ts             createServer(): register calls only, no logic
src/tools/                run_playwright_test, run_cypress_test, read_test_report
src/resources/            qa://test-strategy, qa://playwright-guidelines
src/prompts/              generate-playwright-test, analyze-test-failure
src/config.ts             execution mode, project dir, timeout (env, read per call)
src/environments.ts       closed environment enum -> operator-provided base URL
src/runners.ts            operator-provided Cypress/Playwright invocation details
src/execution/adapter.ts  runInProject(): the only path to a live process
src/utils/command.ts      runCommand() and sanitizeArg()
src/capabilities/flaky-test-triage/
  schema.ts               observation in, judgment out (zod)
  rules.ts, repairs.ts    the expertise: signals, classifier, repair contract
  evaluator.ts            pure orchestration: triageFlakyTest()
  adapters.ts             Playwright JSON, Mochawesome, JUnit XML -> observations
  tool.ts, prompts/       MCP exposure: triage_flaky_test, flaky-test-triage
  tests/, fixtures/, examples/, docs/reasoning.md
examples/                 sample spec; triage-report.mjs (imports from dist/)
```

## Commands

These are the only scripts in `package.json`. There is no lint, format, CI, or
release command; do not invent or assume one.

```bash
pnpm install     # install dependencies
pnpm typecheck   # tsc --noEmit
pnpm build       # tsc -> dist/ (gitignored)
pnpm test        # node:test via tsx
pnpm dev         # run from source over stdio
pnpm start       # run dist/index.js over stdio
```

- `pnpm test` only picks up `src/*.test.ts` and `src/capabilities/*/tests/*.test.ts`.
- `pnpm dev` and `pnpm start` block waiting for an MCP client on stdio. They are
  not a validation step.
- `examples/triage-report.mjs` needs `pnpm build` first.

## Code conventions

- TypeScript `strict`, ESM, `Node16` module resolution. Relative imports end in `.js`.
- Validate every tool and prompt input with `zod`.
- Each tool, resource, and prompt lives in its own file and exports
  `register<Name>(server: McpServer): void`. A capability that encodes QA
  expertise gets its own folder under `src/capabilities/`.
- `src/server.ts` stays wiring-only: one import and one register call per
  registered capability.
- stdout carries the MCP protocol. Never write to it from `src/` (no
  `console.log`). Diagnostics go to stderr (`console.error`).
- Avoid new dependencies. The report adapters are deliberately dependency-free.

## Security invariants

Tool inputs come from an LLM and are untrusted. Operator configuration comes
from environment variables and is trusted. Preserve all of the following:

- No generic terminal tool, and no arbitrary command input from the caller.
- Run tools are dry-run by default. Live execution happens only when the
  operator sets both `QA_MCP_EXECUTION_MODE=live` and `QA_MCP_PROJECT_DIR`.
- Callers choose typed, constrained inputs; `environment` is a closed enum.
  Base URLs, config files, and other project-specific details are operator
  configuration, never tool parameters.
- Processes start only through `runInProject()` and `runCommand()`: an
  allowlisted binary, an argv array, `shell: false`. Never use `exec`,
  `execSync`, `shell: true`, or a command built as a string. Do not extend
  `ALLOWED_COMMANDS` without explicit maintainer approval.
- Timeouts, output size limits, `sanitizeArg()`, and the `..` traversal check
  stay in place.

Describe these protections as they are, and state intended guarantees as
intentions. Current limitations to keep in mind:

- The configured working directory and the `..` check are not a filesystem
  sandbox.
- `read_test_report` resolves paths from `process.cwd()`; it is not confined to
  `QA_MCP_PROJECT_DIR`.
- Free-form caller strings are stripped of control characters, not allowlisted.
- Live test code runs with the server's privileges and environment.

Before a substantial change to the execution boundary (`src/execution/`,
`src/utils/command.ts`, `src/config.ts`, `src/environments.ts`,
`src/runners.ts`, or a tool input schema), briefly explain the approach and its
risks, in proportion to the task. Such changes need tests and matching
documentation updates.

## Flaky-test triage

- The [reasoning spec](src/capabilities/flaky-test-triage/docs/reasoning.md)
  states the intended reasoning and `rules.ts` implements it. Change them
  together, with tests that pin the behavior.
- Preserve these invariants:
  - A pass on retry at the same commit is judged flaky, never a regression.
  - `likely_real_regression` always sets `quarantineForbidden`, even when the
    failure is pre-existing on the baseline, and has no allowed test repair.
  - Baseline evidence sets `preExisting` only. It never votes for a
    classification and never relaxes the quarantine guard.
  - Vendor signals adjust confidence only. They never change the classification.
  - The universal forbidden-repair list applies to every classification.
- Judgments stay evidence-based: every evidence item cites what was observed in
  the input. `inconclusive` is a valid outcome; do not force a verdict or
  inflate confidence.
- `triageFlakyTest()` stays pure and deterministic. Adapters normalize reports,
  tolerate malformed input without throwing, and contain no judgment.
- The input schema in `tool.ts` mirrors `schema.ts`. Keep them in sync.
- Never hide a likely regression, in this repository's tests or in guidance the
  server emits: no weakened or removed assertions, no skipped or disabled
  tests, no arbitrary sleeps, no blanket retries, no expected values edited to
  match wrong behavior.

## Changes and validation

- Keep changes focused. No drive-by refactors, new frameworks, CI, templates,
  or documentation rewrites unless asked.
- Add or update tests that exercise the behavior you changed.
- Validate in proportion to the change:
  - Code: `pnpm typecheck` and `pnpm test`; add `pnpm build` when emitted
    output or `examples/` are affected.
  - Documentation only: check the content against the code and check that
    links resolve. Code tests are not required.
- Update README or ROADMAP when the public surface changes (tools, resources,
  prompts, environment variables).

## Implemented, roadmap, proposal

Keep these visibly separate in code comments, documentation, and reports:

- Implemented: behavior that exists in `src/` today, as established by code and
  tests. This covers registered tools, resources, and prompts as well as
  internal modules and adapters that are not registered in `src/server.ts`.
  Say whether something is exposed over MCP or internal only.
- Roadmap: direction described in [ROADMAP.md](ROADMAP.md) or
  [docs/vision.md](docs/vision.md). Not a commitment and not a feature.
- Proposal: your own suggestion. Label it as such, and never document planned
  behavior in the present tense.

## Public repository hygiene

This is a public, MIT-licensed repository. Do not commit credentials, tokens,
private client or employer data, personal history, internal URLs, real local
paths, names of private projects, or confidential logs. This applies to code,
tests, fixtures, documentation, and commit messages. Use synthetic examples
(`/absolute/path/to/...`, `example.com`, `localhost`).

## Scope and authorization

- Do what was asked, within the scope the user authorized.
- Do not merge, push, tag, publish, release, or open or close issues and pull
  requests without explicit authorization.
- Do not run live tests against external environments without explicit
  authorization. Never target `production` on your own initiative.
- When a request conflicts with the security invariants, stop and say so.

## Reporting

When you finish, state the checks you ran and their results, the checks you did
not run and why, your assumptions, and known limitations or unfinished work. Do
not claim a check passed unless you executed it.
