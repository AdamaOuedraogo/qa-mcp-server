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

## Design decisions

- **One capability per file.** Predictable, reviewable, easy to test.
- **Register-function pattern.** Keeps the server file declarative.
- **`zod` schemas.** Runtime validation plus generated types and client-facing
  input descriptions.
- **ESM + `Node16` module resolution.** Matches the SDK and modern Node.
- **Safety by construction.** Execution paths go through one audited helper.
