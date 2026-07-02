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
        ├── tools/       controlled QA actions
        ├── resources/   reference material (markdown)
        ├── prompts/     reusable QA reasoning templates
        └── utils/       safe command execution helper
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

In the MVP, the run tools describe the command they *would* execute (dry run)
rather than executing it, keeping the server safe to connect anywhere by
default. The runner exists so enabling real execution later is a small,
reviewable change.

## Execution pipeline

A tool request flows through a fixed sequence of stages:

```text
LLM tool call
     │
     ▼
1. Transport        JSON-RPC over stdio → McpServer
2. Validation       zod parses arguments; malformed input is rejected here
3. Sanitization     sanitizeArg() strips control characters from values
4. Handler          the tool's own logic builds the argument list
5. Security boundary allowlist + no-shell (runCommand); not crossed in dry run
6. Execution        dry run today (command is described, not run);
                    real execution in a future version
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
- **Dry run by default.** The run tools do not execute anything in the MVP, so
  connecting the server has no side effects.

Real execution, when added, must not weaken these properties: it should sit
behind an explicit security boundary rather than being wired directly into a
handler.

## Future execution model

Enabling real Playwright/Cypress runs should be an additive, reviewable change,
not a rewrite. The intended shape:

- **Execution adapter.** Handlers do not spawn processes directly. They hand a
  validated, sanitized request to an adapter that owns process execution via
  `runCommand`. This keeps the security boundary in one auditable place.
- **Opt-in.** Real execution is disabled unless explicitly enabled (e.g. a
  config flag / environment variable), so the safe behaviour remains the
  default.
- **Isolation when appropriate.** For untrusted or higher-risk runs, the adapter
  may execute inside an isolated environment — a container (such as Docker) or
  another sandbox. This is *one possible implementation*, not the goal itself;
  the requirement is isolation, and the mechanism can vary.

The vision is the boundary and the opt-in, not any specific sandbox technology.

## Extension model

Adding a capability follows the same **one file + one register function**
pattern everywhere:

1. Create a file in `src/tools/`, `src/resources/`, or `src/prompts/`.
2. Export a `register<Name>(server)` function that declares the capability
   (name, description, `zod` schema where applicable, and a handler).
3. For tools that take free-form values, run them through `sanitizeArg()`.
4. Register it with a single call in `src/server.ts`.

No other file needs to change. The composition root stays declarative, and each
capability remains independently readable, reviewable, and testable.

## Design decisions

- **One capability per file.** Predictable, reviewable, easy to test.
- **Register-function pattern.** Keeps the server file declarative.
- **`zod` schemas.** Runtime validation plus generated types and client-facing
  input descriptions.
- **ESM + `Node16` module resolution.** Matches the SDK and modern Node.
- **Safety by construction.** Execution paths go through one audited helper.
