# Test Strategy Assessment — a QA Expertise Capability

`audit_test_suite` reads the code. This capability reads the **practice**:
the strategy document, how the team prioritises by risk, who owns the tests,
what gates a merge, what happens to a flaky test, whether there is a
community of practice. None of that lives in a spec file, so the observation
is a typed questionnaire an agent fills in from documents and interviews.

```
Raw Data (what the team writes and says)  ->  QA Expertise  ->  Structured Judgment
```

Every answer accepts `unknown`. That is deliberate: on day one you do not
know most of this, and pretending otherwise produces a confident, wrong
report. An unknown never becomes a gap — it becomes a **question to ask**,
with why it matters, and it lowers the judgment's `confidence`.

## What it returns

- **Maturity per axis** — strategy & risk, automation practice, CI &
  feedback, people & adoption (0 absent → 4 optimized; an axis with unknowns
  is capped at 2).
- **Gaps** with severity, impact, recommendation and a horizon (30/60/90 days).
- **Open questions** — the interview guide for the next meeting.
- **A 30/60/90-day plan** built from the gaps' horizons.
- **Services** — the engagement types that address the gaps: risk-based
  strategy workshop, E2E stabilisation (audit + fix PR), CI feedback-loop
  improvement, automation standards + coaching, community-of-practice launch,
  governed AI-assisted testing pilot. Names describe outcomes, not a vendor.

## Layout

| File / dir       | Role |
| ---------------- | ---- |
| `schema.ts`      | The questionnaire (observation) and the judgment. |
| `rules.ts`       | **The expertise.** Gap rules, question bank, scoring, service mapping, plan. |
| `evaluator.ts`   | Pure orchestration: `assessTestStrategy(observation)`. |
| `tool.ts`        | MCP exposure: `assess_test_strategy` and its Markdown rendering. |
| `tests/`         | Tests that pin the expertise and the unknown → question behaviour. |

## Try it

Start the server and call `assess_test_strategy` with the questionnaire; the
`qa-audit` prompt walks an agent through filling it after the code audit.

```bash
node --import tsx --test src/capabilities/test-strategy-assessment/tests/*.test.ts
```
