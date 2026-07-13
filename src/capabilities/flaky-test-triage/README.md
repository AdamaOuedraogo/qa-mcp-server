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
  "safeRepairs": {
    "allowed": [ "Stub the unstable external dependency instead of hitting it live." ],
    "forbidden": [ "Add or increase an arbitrary fixed sleep to 'stabilize' the test." ]
  },
  "preExisting": false,
  "quarantineForbidden": false
}
```

## What this capability decides

Given one failing test's attempts (and, if available, its recent history), is the
failure **flaky** — and which kind — or a **real regression**? It answers with a
classification, a confidence, the evidence behind it, prioritized actions, and a
hard guard: it refuses to quarantine a likely regression. Two more judgments ride
along:

- **`preExisting`** — cross-references the **baseline** (target branch). If the same
  test already fails there, the failure wasn't introduced by this change. It's still
  a bug if deterministic — just not *this* change's bug, so it must not block it.
- **`safeRepairs`** — a per-classification contract of what you **may** and **must
  never** change to fix the test. The `forbidden` list is the guard against an agent
  turning a red test green by hiding the defect (sleeping, weakening assertions,
  `.skip()`-ing, blanket-retrying).

Full reasoning: [`docs/reasoning.md`](docs/reasoning.md).

## Layout

| File / dir            | Role |
| --------------------- | ---- |
| `schema.ts`           | The data contract — observation in, **judgment** out (Rule #1). |
| `rules.ts`            | **The expertise.** Signal detectors (incl. baseline cross-ref) + classifier + actions. |
| `repairs.ts`          | The safe-repair contract: allowed vs **forbidden** repairs per family. |
| `evaluator.ts`        | Pure orchestration: observation → judgment. |
| `adapters.ts`         | Tools as observation sources: Playwright JSON, Mochawesome, **JUnit XML**, + `parseTestReport` (auto-detects junit vs json). |
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

## Feeding it a report

`parseTestReport(raw, format?)` turns a CI report into observations, auto-detecting
XML vs JSON. Notes distilled from the Playwright and Cypress reporter docs:

- **JUnit is universal but coarse.** `mocha-junit-reporter` (Cypress) and Playwright's
  `junit` reporter both emit one `<testcase>` per test — the *final* outcome. JUnit does
  not model retries as attempts, so within-run flake (our strongest signal, passed-on-retry)
  is invisible there; supply cross-run `history`, or use a richer source.
- **Prefer Playwright's JSON reporter for flakiness** (`reporter: [['json', …]]`): its
  `results[]` array carries each retry attempt, which the triage reads directly.
- **Cypress writes one XML per spec** (`mochaFile: '…/[hash]-report-junit.xml'`) to avoid
  overwrites; merge them in CI (e.g. `junit-report-merger`) before triaging a whole run.
  `fromJUnitXml` handles both a merged multi-suite file and per-spec files.
- Playwright JUnit uses `<failure … type="FAILURE">` and adds `<system-out>` attachment
  lines; the adapter reads the failure and ignores the rest.

## Try it via MCP

The capability is registered in `src/server.ts` as the `triage_flaky_test` tool
and the `flaky-test-triage` prompt. Start the server (`pnpm dev`) and call the
tool with one test's `attempts`.
