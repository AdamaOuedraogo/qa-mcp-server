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
5. **Not observed is not absent.** A missing config or CI file at the audited
   root may mean "it lives elsewhere". Such findings carry
   `basis: not_observed`, weigh half in scoring, never trigger the critical
   cap, and are summarised in `completeness`. Rules that need the config
   (reporters, traces, retries, parallelism) do not fire when it was not
   found; `CFG-001` reports the gap instead. A config that was found but
   refused by the confined read is treated the same way: it is not present
   (`configNotRead` records the path and the refusal kind), and a refused CI
   file turns an observed absence into "not established".
6. **Heuristics are labelled.** Assertion detection is line-based and
   name-based (inline `expect/should/assert`, helpers named `verify…`,
   `assert…`, `check…`); `COV-004` says "visible assertion", is medium at
   most, and asks the auditor to read each test before reporting it.
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
| SPD-001 | Playwright, ≥10 specs, config sets a single worker (`workers: 1`, or `workers: process.env.CI ? 1 : …`) | medium |
| SPD-002 | E2E job in CI, ≥20 specs, no `parallel:`/matrix/`--shard` in that job | medium (`not_observed` when not established) |
| SPD-003 | E2E job without a dependency/browser cache in that job | low (`not_observed` when not established) |

Cypress parallelism is a CI/cloud concern, so SPD-001 is Playwright-only.
Playwright runs spec files in parallel by default, and `fullyParallel` only
adds parallelism within a file, so neither a missing `workers` nor
`fullyParallel: false` is serial. SPD-001 states the configuration; it does
not claim a measured run time.

### Coverage & risk — "what does a red pipeline actually block?"

| Rule | Flags | Severity logic |
| --- | --- | --- |
| COV-000 | no specs found | critical (nothing to audit — probably the wrong root) |
| COV-001 | < 50 % of specs carry a criticality tag (`@p0`, `@p1`, `@p2`, `@critical`); scope/execution tags (`@smoke`, `@sanity`, `@regression`, `@nightly`, `@slow`, `@wip`) are reported in `scopeTags` and do not count | high if none, else medium — the base of a risk-based strategy |
| COV-002 | `.skip`/`fixme`/`xit` | high ≥10, medium ≥3, else low |
| COV-003 | `.only`/`fit`/`fdescribe` committed | **critical** — silently removes coverage on CI |
| COV-004 | tests without a *visible* assertion (heuristic) | medium ≥10, else low |
| COV-005 | no CI definition at the root (`not_observed`); CI where the command appears only outside an enabled job's script, or jobs come from files not read (`not_observed`); or CI with no job that *runs* an E2E command | high / high / high |
| COV-006 | the E2E job has no scheduled run | low (`not_observed` when not established, e.g. GitLab schedules set in the UI) |

### Observability — "can anyone investigate without re-running?"

| Rule | Flags | Severity logic |
| --- | --- | --- |
| CFG-001 | specs found but no runner config at the root, or one that was found but not read (`not_observed`) | medium — and OBS-001/002, REL-004, SPD-001 stay silent |
| OBS-001 | no JSON/JUnit/Allure/Mochawesome reporter | high — without it there is no trend and nothing for AI-assisted triage |
| OBS-002 | trace/screenshot off (or nothing configured on Playwright) | medium |
| OBS-003 | E2E job publishes no artifacts | medium (`not_observed` when not established) |

### Governance — "would this survive the consultant leaving?"

| Rule | Flags | Severity logic |
| --- | --- | --- |
| GOV-001 | literal password/token in test code | **critical** |
| GOV-002 | no README/CONTRIBUTING/TESTING section about tests | medium |
| GOV-003 | no dedicated E2E script in `package.json` | low |
| GOV-004 | no lockfile | medium |

## CI detection

**Principle.** The scanner states a CI behaviour only with structural and
semantic evidence: the construct is where the CI system reads it (the job's
own script or steps, the trigger keys) and means what is claimed (a test run,
a gate, a shard). Otherwise it returns `not_observed` with a reason. An
abstention is for a construct it does not support, never a cover for
misreading one it does. Every `true` in `ci` carries its file, job and line
in `ci.evidence`; every undefined setting or gate carries its reason in
`ci.reasons` (or `e2eJobNotEstablished`). The supported and abstaining
constructs are listed in the capability README.

CI files are split into jobs by indentation (`ci.ts`; no YAML parser). A job
runs the suite only if its *own* `script:`/`before_script:` (GitLab), or the
direct `run` key or a `uses: cypress-io/github-action` key of an item of
`jobs.<job>.steps` (GitHub), holds a run command. A `run:` under `env:`,
`with:` or the job itself is not a step command; a step with `if: false` does
not count, and a command step with its own `if:` leaves the gate undefined.
On GitHub, artifacts, JUnit reporting, retries and caching are read only from
step `uses`/`with` keys; a step that uses an action outside a known list was
not read, so those settings are undefined, never false. GitHub has no
built-in test report, so JUnit wiring is either a known reporter action
(true) or not established.

Run commands are matched in command position only: at the start of a logical
command (a line, or after `&&`, `||`, `;`; backslash continuations joined;
`VAR=value` prefixes skipped), after YAML comments are stripped (a `#` inside
quotes is not a comment). `playwright test` and `cypress run`, directly or via
`npx`/`pnpm exec`/`yarn`/`bunx`/a `node_modules/.bin` path, are *observed*;
`--list`, `--help` and `--version` run nothing. `install`, `open`, `echo …`
and bare `playwright`/`cypress`/`ui` script names are not runs. A package
script recognised by its name only (`e2e`, `test:e2e`, `e2e:*`) is an
*inferred* E2E job: its body was not read, and a finding that rests on it
carries `basis: inferred` (weighed like `not_observed`). The same text in `variables:`, `env:`, a template or an
`image:` line is not an E2E job; when that is the only place it appears, or
jobs come from `include:`/a reusable workflow, the absence of an E2E job is
*not established* (`e2eJobNotEstablished`) rather than observed.

A setting counts for the E2E job only when it sits in that job. Absent from
the job but present elsewhere (another job, GitLab `default:`, a template), or
inherited through `extends:`/`<<:`/`!reference`/a local action, it is *not
established* (`undefined`) and the rule reports `not_observed`.

`false` is a claim too: a setting is false only when the construct that
would carry it was fully read and does not carry it. Per setting:
- sharding: true only with a shard argument in the E2E command (`--shard`,
  Cypress `--parallel`, the Cypress action's `parallel: true`); false only for
  a direct command with no concurrency and no shard argument. `parallel: N` or
  a matrix without a shard argument, or a command that is only an inferred
  package script, is not established;
- JUnit: GitLab needs the `artifacts → reports → junit` path (a `junit.xml`
  under `paths` is not it); GitHub needs a known reporter action, else it is
  not established, never false;
- retry: GitLab `retry: 1|2`, or `max: 1|2` with `when` absent or including
  `always`/`script_failure`, is blanket; `retry: 0` or a `when` limited to
  infrastructure failures is not; GitHub needs a known retry action;
- cache: a GitLab `cache:` block is a cache, `cache: []` is not; GitHub needs
  `actions/cache` or a `with.cache` that is not false;
- any of these in an unsupported form, or carried by a step that uses an
  action that was not read, is not established.

GitLab rules are read, not evaluated. A rule is *unconditional* when it has
no `if`, no `changes` and no `exists`; an unconditional first rule decides
every pipeline (`when: never` disables the job, `when: manual` makes it
manual-only) and later rules are never reached. The merge-request gate (and
likewise the schedule) is decided only when exactly one rule can apply to
merge-request pipelines and its condition is a plain
`$CI_PIPELINE_SOURCE == "merge_request_event"` test without `changes`/`exists`:
`when: never`/`manual` or a rule-level `allow_failure: true` gives `false`,
otherwise `true`. A rule that tests another source plainly cannot apply; any
other rule can. Anything else (several candidate rules, negations, other
variables, `changes`, `workflow: rules`, `except:`, a non-boolean
`allow_failure`) leaves the gate undefined, with the reason in `ci.reasons`.
A job that uses `extends`, a merge key, `!reference` or an alias, or whose
`rules`/`when` use an unsupported form, has an unknown enabled state: it does
not establish an E2E job, and the reason names the construct.

GitHub triggers are the keys of `on:` (a scalar, a flow sequence or a block
mapping; a flow mapping abstains); words inside a trigger's options are not
triggers. `pull_request` gates merges unless its `types` exclude `opened`,
`synchronize` and `reopened` (then `false`); a `paths`/`paths-ignore` filter
leaves the gate undefined; `merge_group` gates. The schedule is `false` only
when `on:` was fully read and has no `schedule` key. A job or step with its
own `if:`, or a reusable workflow (`workflow_call`), leaves both undefined.

Unsupported constructs abstain with a reason: GitLab `include:` (included
files may set `default:`, so an absent setting is not established), a
`trigger:` job (the child pipeline is not read), a job that runs a local
script, a shell file, `make`, `just` or `task` (the absence of an E2E job is
not established), and a job that repeats a key (YAML keeps the last one; the
job's enabled state is unknown).

Gates: a disabled job (`when: never`, `if: false`, a hidden `.template`) is
not an E2E job. A manual-only job (`when: manual`, a GitHub workflow with only
`workflow_dispatch`) or one allowed to fail (`allow_failure`,
`continue-on-error`) is not a merge-request gate (`runsOnMergeRequest:
false`). A GitLab job without a merge-request rule, or a GitHub job with its
own `if:`, leaves the gate not established.

## Scoring

Each axis starts at 4 and deducts 3 / 1.5 / 1 / 0.5 per critical / high /
medium / low finding (half of that for `not_observed` findings), floored at
0. An *observed* critical finding caps the axis at 1. An
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
