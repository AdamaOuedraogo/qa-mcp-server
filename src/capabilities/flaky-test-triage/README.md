# Flaky Test Triage — a QA Expertise Capability

This folder is the reference implementation of a **QA Expertise Capability**: the
unit this project is actually made of. Read it as the template for every future
capability.

## What a QA Expertise Capability is

> A capability is the *implementation of an expertise*, not a wrapper around a tool.

The inversion that defines the project:

```
Expertise  ->  Capability  ->  Tool
```

The expertise is the product. The capability is how we make it executable by an
AI agent. Tools (Playwright, Cypress, JUnit, GitLab, Jira) are only **sources of
observation** feeding it.

And the one architectural rule every capability obeys:

```
Raw Data  ->  QA Expertise  ->  Structured Judgment
```

A module that returns `{ "tests_failed": 14 }` is a connector. A capability
returns:

```json
{
  "classification": "flaky_infrastructure",
  "confidence": 0.91,
  "summary": "Likely flaky — infrastructure/timing, not a product bug.",
  "evidence": [ { "signal": "passed-on-retry", "observation": "…" } ],
  "recommendedActions": [ { "action": "Quarantine to unblock the pipeline", "priority": "now" } ],
  "quarantineForbidden": false
}
```

## What this capability decides

Given one failing test's attempts (and, if available, its recent history), is the
failure **flaky** — and which kind — or a **real regression**? It answers with a
classification, a confidence, the evidence behind it, prioritized actions, and a
hard guard: it refuses to quarantine a likely regression.

Full reasoning: [`docs/reasoning.md`](docs/reasoning.md).

## Layout

| File / dir            | Role |
| --------------------- | ---- |
| `schema.ts`           | The data contract — observation in, **judgment** out (Rule #1). |
| `rules.ts`            | **The expertise.** Signal detectors + classifier + actions. |
| `evaluator.ts`        | Pure orchestration: observation → judgment. |
| `adapters.ts`         | Tools as observation sources (Playwright, Mochawesome). |
| `tool.ts`             | MCP exposure: the `triage_flaky_test` tool. |
| `prompts/`            | MCP prompt framing the agent to use the capability, not guess. |
| `fixtures/`           | Real reporter shapes: `playwright.json`, `mochawesome.json`, `junit.xml`. |
| `examples/`           | Worked input → judgment walkthroughs. |
| `tests/`              | Tests that pin the *expertise*, not just the plumbing. |
| `docs/reasoning.md`   | The spec: why each signal weighs what it does. |

## Run the tests

```bash
node --import tsx --test src/capabilities/flaky-test-triage/tests/*.test.ts
```

## Try it via MCP

The capability is registered in `src/server.ts` as the `triage_flaky_test` tool
and the `flaky-test-triage` prompt. Start the server (`pnpm dev`) and call the
tool with one test's `attempts`.
