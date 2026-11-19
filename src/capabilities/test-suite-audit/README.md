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
- **What is wrong and where** — 30 rules, each with a severity, an effort
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
- **Confined.** It scans `QA_MCP_PROJECT_DIR` and refuses when the variable
  is unset, not absolute or cannot be resolved; there is no working-directory
  fallback. The caller can narrow to a sub-folder; `..`, absolute paths,
  drive/UNC prefixes and control characters are rejected outright, not
  cleaned, and a sub-folder that resolves outside the project is refused.
  Each file is read through the same confined read as `read_test_report`
  (`O_NOFOLLOW` open, `realpath` containment, device/inode match, bounded
  read). The walk does not follow symlinks. A refused file is not analysed;
  the output lists each one with its refusal kind and the summary states how
  many there were. A root that is itself a symlink is resolved with
  `realpath`, as `read_test_report` does. A hard link or a bind mount inside
  the project is not detected; this is not a filesystem sandbox.
- **Bounded.** Vendor/build directories skipped, at most 400 spec files by
  default and 512 KiB per file; every cap hit is listed in the judgment's
  `caveats` and reflected in `completeness`.
- **Credential redaction at the output boundary.** Every evidence snippet,
  path and note is passed through `redact.ts` in the evaluator — whether the
  observation came from the scanner or was supplied by the caller. Lines that
  look like they carry a credential have their quoted literals replaced by
  `***`; bearer tokens, JWTs and common key prefixes are masked anywhere. This
  is pattern-based: an unusual secret shape can still get through, so treat the
  judgment as *reduced*-risk to paste, not as sanitised.
- **Observed vs. not observed.** Each finding carries a `basis`: `observed`
  (the smell is in the files) or `not_observed` (something expected was not
  found at the audited root — config, CI, lockfile — and may live elsewhere).
  Not-observed findings weigh half in scoring and never trigger the critical
  cap. The `completeness` block says how much of the expected input the scan
  saw, so a partial scan is not mistaken for an immature suite.
- **Heuristic findings say so.** `COV-004` (tests without a *visible*
  assertion) recognises inline `expect/should/assert` and calls to helpers
  named like assertions; a helper that asserts under another name is missed.
  Its title and severity reflect that.
- **Excerpts are labelled as data.** Each finding's evidence list, and the
  JSON judgment that repeats it, is returned inside `wrapUntrusted()`
  delimiters with a per-call token, so a quoted line cannot forge the closing
  line. This is best-effort labelling, not a security boundary.

## CI files: what is read

The CI analysis (`ci.ts`) has no YAML parser. It reads the constructs below
and gives a definite answer for them; anything else abstains: the value is
left undefined with a reason in `ci.reasons` or `ci.e2eJobNotEstablished`,
and the finding is `not_observed`. The rules are in
[docs/reasoning.md](docs/reasoning.md#ci-detection).

**Read (definite answers)**

- Block mappings and block sequences split by indentation; `#` comments
  outside quotes.
- Flow forms, the same rule for the whole file: a plain or quoted scalar, and
  a flow sequence of plain or quoted scalars (`[push, pull_request]`,
  `script: [npx playwright test]`, `when: [script_failure]`).
- Commands in command position (line start, after `&&`, `||`, `;`, past
  `VAR=value`, backslash continuations joined): `playwright test` and
  `cypress run`, directly or via `npx`, `pnpm exec`, `yarn`, `bunx` or a
  `node_modules/.bin` path. A package script named `e2e`, `test:e2e` or
  `e2e:*` is read as an *inferred* E2E job.
- GitLab: jobs (top-level keys other than the reserved ones; `.hidden` jobs
  are templates), `script`/`before_script`, job-level `when`, a plain boolean
  `allow_failure`, `rules` items with `if`/`when`/`allow_failure`, an
  unconditional first rule, a single rule with a plain
  `$CI_PIPELINE_SOURCE == "…"` test, `only:` as a list of keywords,
  `artifacts` and `artifacts:reports:junit`, `parallel`, `retry` (scalar, or
  `max` with `when`), `cache` blocks and `cache: []`, `default:` as "set
  elsewhere".
- GitHub: `on:` as a scalar, a flow list or block keys; `pull_request`
  `types`, `branches`; `merge_group`; `schedule`; `workflow_dispatch`-only;
  job `if: false`, `continue-on-error`, `strategy.matrix`; `jobs.<job>.steps`
  items by their direct `run` (scalar, `|`, `>`), `uses`, `if`,
  `continue-on-error` and `with` keys; known actions: checkout, setup-*,
  pnpm/bun setup, cache, upload/download-artifact, the Cypress action, three
  JUnit reporters (dorny/test-reporter, mikepenz/action-junit-report,
  EnricoMi/publish-unit-test-result-action) and two retry actions.

**Abstains (undefined, with the reason)**

- Every other flow form: flow mappings `{…}`, nested flow collections,
  commas or brackets inside quotes, aliases `*name`.
- Inheritance and references: `extends`, merge keys `<<:`, `!reference`;
  GitLab `include:`, `trigger:` child pipelines; GitHub reusable workflows
  (`uses:` on a job, `workflow_call`) and local actions (`uses: ./…`);
  third-party actions outside the known list.
- Rule evaluation: several rules that can apply to the same pipeline source,
  conditions other than a plain pipeline-source test (negations, `=~`,
  `&&`, other variables), `changes`/`exists` on the deciding rule,
  `workflow: rules`, `except:`, `only:` with `refs`/`variables`/`changes`,
  `allow_failure` as a mapping; GitHub job or step `if:` expressions other
  than `false`, `pull_request` `paths` filters.
- Commands whose content is elsewhere: a local script, `bash`/`sh` of a file,
  `make`, `just`, `task`, and package scripts for sharding (their body is not
  read).
- Concurrency without a shard argument (`parallel: N`, a matrix).
- A job that repeats a key, multi-document files and cross-file `extends`.

## Layout

| File / dir           | Role |
| -------------------- | ---- |
| `schema.ts`          | The data contract — observation in, **judgment** out. |
| `scanner.ts`         | Facts only: walks the project, reads specs/config/CI. No judgment. |
| `rules.ts`           | **The expertise.** Finding rules, axis scoring, hotspot ranking, action planning. |
| `evaluator.ts`       | Pure orchestration: `auditTestSuite(observation)`; applies redaction and computes completeness. |
| `redact.ts`          | Output-boundary credential masking for every snippet, path and note. |
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
