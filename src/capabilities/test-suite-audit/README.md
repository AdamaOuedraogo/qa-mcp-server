# Test Suite Audit — a QA Expertise Capability

The "first day at a client" capability. Point it at a Playwright or Cypress
project and it returns what a senior QA consultant would put in a day-one
audit: a maturity score per axis, findings backed by `file:line` evidence,
the hotspot files to fix first, and an action plan in the shape of a short
engagement — **Diagnose → Prototype → Adopt**.

Same rule as every capability in this project:

```
Raw Data (files, config, CI)  ->  QA Expertise  ->  Structured Judgment
```

A module that returns `{ "hardWaits": 14 }` is a connector. This one returns:

```json
{
  "headline": "Playwright suite at maturity level 1/4 (ad hoc) — 19 finding(s), 2 critical, 18 fixable in a short PR.",
  "axes": [ { "axis": "reliability", "level": 0, "label": "absent", "rationale": "5 finding(s): REL-001, REL-004, REL-005, …" } ],
  "findings": [
    {
      "id": "COV-003", "axis": "coverage_and_risk", "severity": "critical", "quickWin": true,
      "title": "A focused test (.only) is committed",
      "observation": "1 .only/fit/fdescribe marker(s) in 1 file(s).",
      "impact": "On CI, `.only` silently disables every other test in the file…",
      "recommendation": "Remove the markers now; add `forbidOnly: !!process.env.CI`…",
      "evidence": [ { "file": "tests/e2e/login.spec.ts", "line": 4, "snippet": "test.only(\"logs in\", …" } ]
    }
  ],
  "hotspots": [ { "path": "tests/e2e/login.spec.ts", "score": 25, "reasons": ["1 focused test", "1 hard wait", "…"] } ],
  "actionPlan": [ { "phase": "prototype", "priority": "now", "action": "Fix the 2 critical finding(s) first…" } ]
}
```

## What it decides

- **How mature is the suite**, on six axes (0 absent → 4 optimized):
  reliability, maintainability, feedback speed, coverage & risk,
  observability, governance. The scale is documented in the
  `qa://audit-rubric` resource.
- **What is wrong and where** — ~30 rules, each with a severity, an effort
  (S/M/L), a `quickWin` flag ("fixable inside a two-day audit, typically in
  one pull request") and up to 8 evidence lines.
- **Where to start** — hotspot spec files ranked by smell density.
- **What to do, in which phase** — diagnose (what to measure with real run
  data), prototype (the first PR), adopt (standards, policy, community).

It also says what it *cannot* see: static analysis cannot measure flakiness,
so every reliability finding comes with a caveat to confirm it against CI
history (`triage_flaky_test` is the capability for that).

## Safety

- **Read-only.** It opens files; it never runs a test or a command.
- **Confined.** It scans `QA_MCP_PROJECT_DIR` when the operator set it, else
  the server's working directory (like `read_test_report`). The caller can
  narrow to a sub-folder but `..`, absolute paths and control characters are
  rejected. This is a path check, not a filesystem sandbox.
- **Bounded.** No symlinks, vendor/build directories skipped, at most 400
  spec files by default and 512 KiB per file; every cap hit is listed in the
  judgment's `caveats`.
- **No secrets in the output.** Evidence lines that match a credential
  pattern are masked (`'***'`) before they leave the scanner.

## Layout

| File / dir           | Role |
| -------------------- | ---- |
| `schema.ts`          | The data contract — observation in, **judgment** out. |
| `scanner.ts`         | Facts only: walks the project, reads specs/config/CI. No judgment. |
| `rules.ts`           | **The expertise.** Finding rules, axis scoring, hotspot ranking, action planning. |
| `evaluator.ts`       | Pure orchestration: `auditTestSuite(observation)`. |
| `tool.ts`            | MCP exposure: the `audit_test_suite` tool and its Markdown rendering. |
| `fixtures/`          | `sample-project/`: a small, deliberately smelly Playwright project. |
| `tests/`             | Tests that pin the expertise and the scanner's honesty. |
| `docs/reasoning.md`  | The spec: why each rule exists and how severities are chosen. |

## Try it

```bash
pnpm build
QA_MCP_PROJECT_DIR=/absolute/path/to/your/test-project npx @modelcontextprotocol/inspector node dist/index.js
# Tools → audit_test_suite → Run (optionally path: "tests/e2e")
```

Or from an agent: read `qa://audit-rubric`, call `audit_test_suite`, then
`assess_test_strategy` for the practice-level view. The `qa-audit` prompt
sequences all of it and asks for the report in the engagement's shape.

### Auditing a project the server cannot read

If the server runs on a machine without the repository, an agent that *can*
read the code may assemble the observation itself (same shape as
`TestSuiteObservationSchema`) and pass it as the `observation` argument.
The expertise is identical; only the source of facts changes.

## Run the tests

```bash
node --import tsx --test src/capabilities/test-suite-audit/tests/*.test.ts
```
