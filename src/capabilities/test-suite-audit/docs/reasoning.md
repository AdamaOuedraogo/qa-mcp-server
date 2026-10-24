# The reasoning behind Test Suite Audit

This document is the spec. `rules.ts` is its implementation. When they
disagree, this file is right and the code is a bug.

The goal is not to count smells — a linter does that. The goal is to answer
the questions a client asks a QA consultant in the first days: **how much can
we trust this suite, what is costing us the most, and what should we do first?**

## Principles

1. **Evidence or nothing.** Every finding carries the `file:line` lines that
   triggered it (capped at 8). A finding the consultant cannot show is a
   finding the team will not act on.
2. **Impact in the team's terms.** Each rule states why it matters as release
   friction, feedback time or trust — never as "best practice says".
3. **Conservative detectors.** A missed smell costs a remark; a false positive
   costs credibility. Regexes name review smells, not syntax, and lean toward
   precision.
4. **Static means static.** The audit sees patterns, not outcomes. It says so
   in `caveats`, and its action plan starts with "measure with real run data".
   `optimized` (4) is never awarded on an axis that has findings or lacks
   positive signals: a code-only review can prove absence of smells, not
   presence of a trend.
5. **Never recommend hiding a failure.** No rule suggests sleeps, skips,
   weakened assertions or blanket retries. Several rules exist to flag them.

## Axes and what each rule weighs

Severity is chosen by the *cost of leaving it*: critical hides coverage or
exposes secrets; high drives most flake/cost/risk; medium is structural; low
is hygiene. Thresholds that depend on scale use the share of spec files
affected, so a 3-file demo and a 300-file suite are judged the same way.

### Reliability — "does red mean broken?"

| Rule | Flags | Severity logic |
| --- | --- | --- |
| REL-001 | fixed sleeps (`waitForTimeout`, `cy.wait(ms)`, `setTimeout`, `sleep(n)`) | high if ≥30 % of files or ≥20 occurrences; medium ≥5; else low |
| REL-002 | `{ force: true }` | medium ≥10, else low |
| REL-003 | `if`/`try` inside a test body | medium ≥15, else low |
| REL-004 | runner `retries ≥ 2` or CI job-level `retry` | high when CI retries the whole job (re-runs regressions too); else medium |
| REL-005 | login typed through the UI in ≥2 specs and no `storageState`/`cy.session`/global setup | high ≥5 files, else medium |

### Maintainability — "how much does each UI change cost?"

| Rule | Flags | Severity logic |
| --- | --- | --- |
| MNT-001 | XPath, `nth-child`, tag chains, `.a .b` class chains | high ≥40 % of files, medium ≥15 %, else low |
| MNT-002 | < 50 % of specs use role/label/text/test-id locators | medium if none, else low |
| MNT-003 | ≥5 specs, < 40 % import a page object/fixture/command module and no `pages/` dir | medium |
| MNT-004 | absolute environment URLs in tests | medium without `baseURL`, else low |
| MNT-005 | specs > 400 lines or > 25 tests | medium ≥5 files, else low |
| MNT-006 | no TypeScript, or `strict` off | low |
| MNT-007 | no ESLint/Biome | low — but a quick win, because it is how standards stop eroding |

### Feedback speed — "how long until a developer knows?"

| Rule | Flags | Severity logic |
| --- | --- | --- |
| SPD-001 | Playwright, ≥10 specs, no `fullyParallel`/`workers>1` | medium |
| SPD-002 | E2E job in CI, ≥20 specs, no `parallel:`/matrix/`--shard` | medium |
| SPD-003 | E2E job without a dependency/browser cache | low |

Cypress parallelism is a CI/cloud concern, so SPD-001 is Playwright-only.

### Coverage & risk — "what does a red pipeline actually block?"

| Rule | Flags | Severity logic |
| --- | --- | --- |
| COV-000 | no specs found | critical (nothing to audit — probably the wrong root) |
| COV-001 | < 50 % of specs carry a priority/scope tag (`@p0`, `@smoke`, …) | high if none, else medium — the base of a risk-based strategy |
| COV-002 | `.skip`/`fixme`/`xit` | high ≥10, medium ≥3, else low |
| COV-003 | `.only`/`fit`/`fdescribe` committed | **critical** — silently removes coverage on CI |
| COV-004 | tests without `expect`/`should`/`assert` | high ≥10, else medium |
| COV-005 | no CI definition, or CI without an E2E job | critical / high |
| COV-006 | no scheduled (nightly) run | low |

### Observability — "can anyone investigate without re-running?"

| Rule | Flags | Severity logic |
| --- | --- | --- |
| OBS-001 | no JSON/JUnit/Allure/Mochawesome reporter | high — without it there is no trend and nothing for AI-assisted triage |
| OBS-002 | trace/screenshot off (or nothing configured on Playwright) | medium |
| OBS-003 | E2E job publishes no artifacts | medium |

### Governance — "would this survive the consultant leaving?"

| Rule | Flags | Severity logic |
| --- | --- | --- |
| GOV-001 | literal password/token in test code | **critical** |
| GOV-002 | no README/CONTRIBUTING/TESTING section about tests | medium |
| GOV-003 | no dedicated E2E script in `package.json` | low |
| GOV-004 | no lockfile | medium |

## Scoring

Each axis starts at 4 and deducts 3 / 1.5 / 1 / 0.5 per critical / high /
medium / low finding, floored at 0. A critical finding caps the axis at 1. An
axis with findings, or without positive signals, is capped at 3. The overall
level is the mean of the axes pulled toward the minimum
(`round((2·mean + min) / 3)`): a suite is only as trustworthy as its weakest
axis.

## Hotspots

Spec files are ranked by weighted smell density (focused test 10, secret 8,
hard wait 3, forced action 2, brittle selector 2, tests without assertion 2,
conditional flow 1.5, UI login 1.5, skip 1, hard-coded URL 1). The top ten
are the files a two-day audit's fix PR should touch: that is where one change
removes the most risk.

## The plan

- **Diagnose** always starts with measuring from real run data and
  interviewing the team: a static audit sees smells, not outcomes, and
  process causes are invisible to a scanner.
- **Prototype** is the critical fixes first, then one PR of quick wins on the
  hotspots — a visible, reviewable improvement that earns the trust needed
  for structural work.
- **Adopt** is the structural findings as team-owned workstreams, the written
  and enforced standard, and a weekly quality review where the observability
  findings pay off (and where `triage_flaky_test` becomes routine).
