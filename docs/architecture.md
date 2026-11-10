# Architecture

The project favours a small, explicit structure over cleverness. The goal is
that a new contributor can add a capability by adding one file and one line.

## Overview

```text
MCP client (Claude Desktop, IDE, ...)
        │  JSON-RPC over stdio
        ▼
   src/index.ts        ← entry point: transport + connect
        │
   src/server.ts       ← wiring only: registers everything
        ├── tools/         controlled QA actions
        ├── capabilities/  QA expertise as judgment (flaky-test-triage)
        ├── resources/     reference material (markdown)
        ├── prompts/       reusable QA reasoning templates
        ├── execution/     the only path to a live process (runInProject)
        └── utils/         safe command execution helper
```

## Layers

### Entry point — `src/index.ts`

Creates the server, attaches a `StdioServerTransport`, and connects. All
diagnostic logging goes to **stderr** so it never corrupts the JSON-RPC stream
on stdout.

### Composition root — `src/server.ts`

`createServer()` instantiates `McpServer` and calls one `register*` function per
capability. It contains **no business logic** — only wiring. Adding a capability
means importing it and calling its register function here.

### Tools — `src/tools/*`

Each tool exports a `register<Name>(server)` function that declares:

- a name and description,
- a typed input schema (via `zod`),
- a handler that returns structured content.

Tools are **controlled**: inputs are typed and constrained. There is no generic
terminal tool.

### Resources — `src/resources/*`

Each resource exports a `register<Name>(server)` function that serves static or
computed reference material under a `qa://` URI.

### Prompts — `src/prompts/*`

Each prompt exports a `register<Name>(server)` function that returns a
parameterised message template for a recurring QA reasoning task.

### Utilities — `src/utils/command.ts`

A single, safe command runner used by tools that (eventually) execute a
process. It is designed to enforce:

- **allowlist** — only pre-approved binaries (`npx`, `pnpm`, `node`),
- **no shell** — arguments passed as an array, never interpolated,
- **timeout** — long-running processes are killed,
- **working directory** — execution pinned to an explicit `cwd`,
- **output size limit** — captured output is truncated.

By default the run tools describe the command they *would* execute (dry run)
rather than executing it, keeping the server safe to connect anywhere. Live
execution is an explicit operator opt-in that reaches this runner only through
the execution adapter (see [Execution model](#execution-model)).

## Execution pipeline

A tool request flows through a fixed sequence of stages:

```text
LLM tool call
     │
     ▼
1. Transport        JSON-RPC over stdio → McpServer
2. Validation       zod parses arguments; malformed input is rejected here
3. Sanitization     sanitizeArg() strips control characters; callerArg()
                    refuses option-like, absolute and ".." caller values
4. Handler          the tool's own logic builds the argument list
5. Security boundary allowlist + no-shell (runCommand); not crossed in dry run
6. Execution        dry run by default (command is described, not run);
                    live only when the operator opts in, via runInProject()
7. Response         structured content returned to the client
```

Each stage has a single responsibility, so a failure is easy to locate: a bad
argument is caught at validation, a suspicious value is neutralised at
sanitization, and no handler can reach a process without passing the security
boundary.

## Security model

The server treats **every tool input as untrusted** — it originates from an LLM,
which may itself be relaying untrusted content.

- **No generic terminal.** There is no tool that runs arbitrary commands. Each
  tool exposes a narrow, typed action.
- **Validation.** Inputs are described and parsed with `zod`; anything that does
  not match the schema is rejected before the handler runs.
- **Sanitization.** `sanitizeArg()` strips control characters (e.g. `\r`, `\n`)
  from argument values so they cannot corrupt a rendered command or smuggle in
  hidden content.
- **No shell.** When a process is run, `runCommand` passes arguments as an array
  with `shell: false` against an allowlist — there is no string interpolation to
  exploit.
- **Caller values stay inside the project.** Free-form run-tool values (a
  spec path, a project or browser name) are refused when they start with `-`,
  are absolute, or contain `..` (`src/tools/callerArgs.ts`), so a caller can
  neither pass an option to the runner nor point it outside the project.
- **Report reads are confined, bound to the descriptor, and bounded.**
  `read_test_report` refuses absolute paths and `..`, then opens the file
  first (with `O_NOFOLLOW` where the platform has it, so the final component
  cannot be a symbolic link), checks that the descriptor is a regular file,
  resolves the path with `realpath`, refuses a target outside
  `QA_MCP_PROJECT_DIR`, and refuses unless the resolved path and the open
  descriptor are the same file (device and inode). The read of at most
  20,000 bytes then uses the descriptor, never the path again. Threat model:
  the containment decision is bound to the opened file, not to a pathname
  that could change between a check and the open. Limitations: on a platform
  without `O_NOFOLLOW` (Windows) a final-component link is followed and only
  the containment and identity checks protect; an intermediate directory
  swapped between the open and the `realpath` is caught by the identity
  comparison, which refuses rather than reads; a hard link inside the project
  to an outside file is indistinguishable by inode, so write access to the
  project directory stays trusted. This is not a filesystem sandbox.
- **Output is labelled as data, best effort.** Captured test output and report
  contents are returned between delimiter lines that carry a per-call random
  token, with a one-line notice (`src/utils/untrusted.ts`), so a body cannot
  forge the closing line and the model is told the block is data. This is
  labelling, not a security boundary: a textual wrapper cannot force a model
  to ignore text inside the block. Returning these contents as structured MCP
  content fields is a follow-up in [ROADMAP.md](../ROADMAP.md).
- **Dry run by default.** The run tools execute nothing unless the operator
  sets both `QA_MCP_EXECUTION_MODE=live` and `QA_MCP_PROJECT_DIR`, so
  connecting the server has no side effects by default.

Real execution does not weaken these properties: it sits behind an explicit
security boundary rather than being wired directly into a handler.

These are the controls that exist today. There is no journal, no approval
gate, no sandbox and no egress allowlist yet; the vision describes them as
intent and [ROADMAP.md](../ROADMAP.md) places them in v0.3. The controls
above are pinned by tests in `src/utils/command.test.ts`,
`src/execution/adapter.test.ts` and `src/tools/*.test.ts`.

## Execution model

Real Playwright/Cypress runs are implemented as an additive layer, not a
rewrite:

- **Execution adapter.** Handlers do not spawn processes directly. They hand a
  validated, sanitized request to `runInProject()` in `src/execution/adapter.ts`,
  which owns process execution via `runCommand`. This keeps the security
  boundary in one auditable place.
- **Opt-in.** Live execution is disabled unless the operator sets both
  `QA_MCP_EXECUTION_MODE=live` and `QA_MCP_PROJECT_DIR` (read in
  `src/config.ts`), so the safe behaviour remains the default. Runs are pinned
  to that directory and arguments containing `..` are rejected.
- **Isolation when appropriate (direction).** For untrusted or higher-risk
  runs, the adapter may later execute inside an isolated environment — a
  container or another sandbox. This is *one possible implementation*, not the
  goal itself; the requirement is isolation, and the mechanism can vary. See
  the optional sandbox item in [ROADMAP.md](../ROADMAP.md).

The vision is the boundary and the opt-in, not any specific sandbox technology.

## Extension model

Adding a capability follows the same **one file + one register function**
pattern everywhere:

1. Create a file in `src/tools/`, `src/resources/`, or `src/prompts/`, or a
   folder under `src/capabilities/` for a capability that encodes QA expertise
   (rules, evaluator, schema and tests next to its MCP exposure).
2. Export a `register<Name>(server)` function that declares the capability
   (name, description, `zod` schema where applicable, and a handler).
3. For tools that take free-form values, run them through `sanitizeArg()`.
4. Register it with a single call in `src/server.ts`.

No other file needs to change. The composition root stays declarative, and each
capability remains independently readable, reviewable, and testable.

## Three layers (direction)

The server is one layer in a three-layer design, and the only one this
repository owns as code. The table and its rationale live in
[docs/vision.md](vision.md) and [ROADMAP.md](../ROADMAP.md); this section only
maps them onto `src/`.

- **Layer 1 — capabilities and primitives (`src/`).** Typed tools, resources
  and prompts, plus capabilities that return a judgment with evidence. Today
  this is the run tools, `read_test_report`, the two resources, the three
  prompts and `triage_flaky_test`. The roadmap adds shared primitives (journal
  and receipts, approval gate, evals, delegation) and the QA lead's
  capabilities (`define_test_strategy`, `assess_release`, `validate_ticket`,
  `review_merge_request`, `investigate_incident`). Those are capabilities in
  `src/`, each a pure judgment over a structured observation, not workflows
  that orchestrate other tools inside the server.
- **Layer 2 — method as skills.** How to chain capabilities for a strategy, a
  release or an incident. This lives in agent and skill instructions in the
  repository, not in server code.
- **Layer 3 — orchestration.** Which agent does what, where, with which
  worker. This belongs to the harness; the repository only documents reference
  setups.

Connectors to first-class inputs (tickets, merge requests, incidents, logs,
knowledge bases) are exploratory roadmap items, not a planned layer. Whatever
is added, the security properties of Layer 1 (typed inputs, no shell, explicit
execution boundary) stay unchanged as the surface grows.

## Design decisions

- **One capability per file.** Predictable, reviewable, easy to test.
- **Register-function pattern.** Keeps the server file declarative.
- **`zod` schemas.** Runtime validation plus generated types and client-facing
  input descriptions.
- **ESM + `Node16` module resolution.** Matches the SDK and modern Node.
- **Safety by construction.** Execution paths go through one audited helper.
