# Contributing

Thanks for your interest in `qa-mcp-server`. This is an early-stage open source
project with a deliberately small scope. Focused, well-argued contributions are
very welcome.

## Philosophy

Please read [`docs/vision.md`](docs/vision.md) first. The guiding rule is:

> Build → learn what is needed → document → publish what was actually built.

We prefer a small, clean, safe foundation over a large, speculative one. If a
change adds surface area, it should also carry its weight in usefulness.

## Contribution Principles

When contributing to this project, please keep these principles in mind.

### Capabilities first

We build small, focused Quality Engineering capabilities before building larger abstractions.

Avoid introducing frameworks or orchestration layers until repeated patterns emerge.

### Safety before convenience

A feature that is easier but less secure is not considered an improvement.

Every capability should preserve the project's security model.

### Build before abstraction

We prefer solving real problems before introducing reusable abstractions.

Patterns should emerge from experience, not speculation.

### Documentation is part of the implementation

Every significant architectural decision should be documented.

Code and documentation evolve together.

## Getting started

```bash
git clone <your-fork-url>
cd qa-mcp-server
pnpm install
pnpm typecheck   # type-check without emitting
pnpm dev         # run the server over stdio
```

## Project layout

- `src/tools/` — one controlled tool per file
- `src/resources/` — one resource per file
- `src/prompts/` — one reusable prompt per file
- `src/utils/` — shared helpers (e.g. safe command execution)
- `src/server.ts` — wiring only; no business logic
- `docs/` — vision and architecture

See [`docs/architecture.md`](docs/architecture.md) for the register-function
pattern each capability follows.

## Adding a capability

1. Create a new file in the appropriate folder.
2. Export a `register<Name>(server)` function.
3. Register it in `src/server.ts` with a single call.
4. Update the README and roadmap if it changes the public surface.

## Safety rules (non-negotiable)

- **No generic terminal tool.** Tools must accept typed, constrained inputs.
- **No arbitrary shell execution.** Route any process execution through
  `src/utils/command.ts`, which enforces an allowlist and never uses a shell.
- Keep tools safe by default. Real execution should be explicit and opt-in.

## Code style

- TypeScript, ESM, `strict` mode.
- Validate tool/prompt inputs with `zod`.
- Keep modules small and single-purpose.
- Match the tone and structure of the existing code.

## How we evaluate contributions

Before opening a pull request, ask yourself:

- Does this solve a real Quality Engineering problem?
- Does it improve safety?
- Does it improve maintainability?
- Does it keep the project simple?
- Does it align with the project's vision?

If the answer is "no" to all of these questions, the contribution probably belongs elsewhere.

## Pull requests

- Keep PRs focused and small where possible.
- Run `pnpm typecheck` before opening a PR.
- Describe the motivation and any trade-offs.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
