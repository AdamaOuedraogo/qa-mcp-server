import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseCi } from "../ci.js";
import type { CiObservation } from "../schema.js";

/**
 * CI analysis, in both directions:
 * - adversarial fixtures: no positive claim without evidence; every true value
 *   points to a line inside an enabled E2E job of the file;
 * - supported fixtures: each construct listed as supported in the capability
 *   README gives a definite, correct answer, not an abstention.
 */

const GL = ".gitlab-ci.yml";
const GH = ".github/workflows/e2e.yml";
const gitlab = (source: string) => ({ ci: analyseCi([{ path: GL, source }]), source });
const github = (source: string) => ({ ci: analyseCi([{ path: GH, source }]), source });

/** Lines [start, end) of a job's block: its key line and everything indented under it. */
function jobRange(source: string, job: string): { start: number; end: number } {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^\\s*${job.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*$`).test(l));
  assert.ok(start >= 0, `job ${job} found in the fixture`);
  const ind = /^ */.exec(lines[start]!)![0].length;
  let end = start + 1;
  while (end < lines.length && (lines[end]!.trim() === "" || /^ */.exec(lines[end]!)![0].length > ind)) end++;
  return { start, end };
}

const BOOLEAN_FIELDS = [
  "e2eJobPresent",
  "runsOnMergeRequest",
  "scheduledRun",
  "artifactsPublished",
  "junitReportWired",
  "parallelOrSharded",
  "blanketJobRetry",
  "dependencyCache",
] as const;

/** Every true value has evidence on a line inside an enabled E2E job's block. */
function assertTrueValuesHaveEvidence({ ci, source }: { ci: CiObservation; source: string }) {
  const lines = source.split("\n");
  for (const f of BOOLEAN_FIELDS) {
    if (ci[f] !== true) continue;
    const ev = ci.evidence?.[f];
    assert.ok(ev, `${f} is true, so it must carry evidence`);
    assert.ok(ci.e2eJobs?.some((j) => j.job === ev.job && j.file === ev.file), `${f}: evidence job ${ev.job} is an enabled E2E job`);
    const r = jobRange(source, ev.job);
    assert.ok(ev.line - 1 >= r.start && ev.line - 1 < r.end, `${f}: line ${ev.line} (${lines[ev.line - 1]?.trim()}) lies inside job ${ev.job}`);
  }
}

/** No field is true; each undefined gate carries a reason. */
function assertNoPositiveClaim(o: { ci: CiObservation; source: string }, fields: ReadonlyArray<(typeof BOOLEAN_FIELDS)[number]>) {
  for (const f of fields) assert.notEqual(o.ci[f], true, `${f} must not be claimed`);
  assertTrueValuesHaveEvidence(o);
}

// --- GitLab rules: adversarial ------------------------------------------------

test("GitLab: an unconditional `when: never` first disables the job, whatever follows", () => {
  const o = gitlab(`e2e:\n  script: [npx playwright test]\n  rules:\n    - when: never\n    - if: $CI_PIPELINE_SOURCE == "merge_request_event"\n    - if: $CI_PIPELINE_SOURCE == "schedule"\n`);
  assert.equal(o.ci.e2eJobPresent, false);
  assertNoPositiveClaim(o, ["runsOnMergeRequest", "scheduledRun"]);
});

test("GitLab: an unconditional `when: manual` first makes the job manual-only, not a gate", () => {
  const o = gitlab(`e2e:\n  script: [npx playwright test]\n  rules:\n    - when: manual\n    - if: $CI_PIPELINE_SOURCE == "merge_request_event"\n`);
  assert.equal(o.ci.e2eJobs?.[0]?.manualOnly, true);
  assert.equal(o.ci.runsOnMergeRequest, false);
  assertTrueValuesHaveEvidence(o);
});

test("GitLab: a rule with changes: or exists: is not unconditional", () => {
  const o = gitlab(`e2e:\n  script: [npx playwright test]\n  rules:\n    - changes: [src/**]\n      when: never\n    - if: $CI_PIPELINE_SOURCE == "merge_request_event"\n`);
  assert.equal(o.ci.e2eJobPresent, true, "the never rule only applies when src/** changes");
  assert.equal(o.ci.runsOnMergeRequest, undefined, "two rules can apply to merge requests");
  assert.match(o.ci.reasons?.runsOnMergeRequest ?? "", /2 rules can apply/);
});

test("GitLab: two rules that can apply to merge requests leave the gate undefined (review fixture)", () => {
  const o = gitlab(
    `e2e:\n  script: [npx playwright test]\n  rules:\n    - if: $CI_PIPELINE_SOURCE == "merge_request_event"\n      when: never\n    - if: $CI_PIPELINE_SOURCE == "merge_request_event"\n`,
  );
  assert.equal(o.ci.runsOnMergeRequest, undefined);
  assert.ok(o.ci.reasons?.runsOnMergeRequest);
});

test("GitLab: conditions that are not plain pipeline-source tests never decide the gate", () => {
  for (const cond of [
    `$CI_PIPELINE_SOURCE != "merge_request_event"`,
    `$CI_MERGE_REQUEST_LABELS =~ /e2e/`,
    `$CI_PIPELINE_SOURCE == "merge_request_event" && $RUN_E2E == "true"`,
  ]) {
    const o = gitlab(`e2e:\n  script: [npx playwright test]\n  rules:\n    - if: '${cond}'\n`);
    assert.equal(o.ci.runsOnMergeRequest, undefined, cond);
    assert.match(o.ci.reasons?.runsOnMergeRequest ?? "", /not a plain/, cond);
  }
  const negSched = gitlab(`e2e:\n  script: [npx playwright test]\n  rules:\n    - if: $CI_PIPELINE_SOURCE != "schedule"\n`);
  assert.equal(negSched.ci.scheduledRun, undefined);
});

test("GitLab: an MR rule restricted by changes:, workflow: rules, except: and allow_failure mappings abstain", () => {
  const cases = [
    `e2e:\n  script: [npx playwright test]\n  rules:\n    - if: $CI_PIPELINE_SOURCE == "merge_request_event"\n      changes: [docs/**]\n`,
    `workflow:\n  rules:\n    - if: $CI_PIPELINE_SOURCE == "merge_request_event"\n      when: never\n    - when: always\ne2e:\n  script: [npx playwright test]\n  rules:\n    - if: $CI_PIPELINE_SOURCE == "merge_request_event"\n`,
    `e2e:\n  script: [npx playwright test]\n  only: [merge_requests]\n  except:\n    variables: [$SKIP_E2E]\n`,
    `e2e:\n  script: [npx playwright test]\n  only:\n    refs: [merge_requests]\n    variables: [$RUN]\n`,
    `e2e:\n  script: [npx playwright test]\n  allow_failure:\n    exit_codes: [1]\n  rules:\n    - if: $CI_PIPELINE_SOURCE == "merge_request_event"\n`,
  ];
  for (const src of cases) {
    const o = gitlab(src);
    assert.equal(o.ci.runsOnMergeRequest, undefined, src);
    assert.ok(o.ci.reasons?.runsOnMergeRequest, `a reason is given for:\n${src}`);
    assertTrueValuesHaveEvidence(o);
  }
});

test("GitLab: extends, merge keys, !reference and aliases make the enabled state unknown, and the reason names the construct", () => {
  const ext = gitlab(`.base:\n  allow_failure: true\ne2e:\n  extends: .base\n  script: [npx playwright test]\n  rules:\n    - if: $CI_PIPELINE_SOURCE == "merge_request_event"\n`);
  assert.equal(ext.ci.e2eJobPresent, false);
  assert.match(ext.ci.e2eJobNotEstablished ?? "", /extends: \.base/);
  assertNoPositiveClaim(ext, ["runsOnMergeRequest"]);

  const alias = gitlab(`.r: &never\n  - when: never\ne2e:\n  script: [npx playwright test]\n  rules: *never\n`);
  assert.equal(alias.ci.e2eJobPresent, false);
  assert.match(alias.ci.e2eJobNotEstablished ?? "", /alias/);

  const merge = gitlab(`.b: &b\n  when: manual\ne2e:\n  <<: *b\n  script: [npx playwright test]\n`);
  assert.equal(merge.ci.e2eJobPresent, false);
  assert.match(merge.ci.e2eJobNotEstablished ?? "", /<<:/);
});

test("GitLab: flow-style rules are an unsupported form and abstain", () => {
  const o = gitlab(`e2e:\n  script: [npx playwright test]\n  rules: [{if: '$CI_PIPELINE_SOURCE == "merge_request_event"', when: never}]\n`);
  assert.equal(o.ci.e2eJobPresent, false);
  assert.match(o.ci.e2eJobNotEstablished ?? "", /unsupported form \(nested flow collection\)/);
});

// --- GitLab rules: supported -------------------------------------------------

test("GitLab supported: a single plain MR rule decides the gate, with its line as evidence", () => {
  const on = gitlab(`e2e:\n  script:\n    - npx playwright test\n  rules:\n    - if: $CI_PIPELINE_SOURCE == "push"\n    - if: $CI_PIPELINE_SOURCE == "merge_request_event"\n`);
  assert.equal(on.ci.runsOnMergeRequest, true);
  assert.deepEqual(on.ci.evidence?.runsOnMergeRequest, { file: GL, job: "e2e", line: 6 });
  assert.deepEqual(on.ci.evidence?.e2eJobPresent, { file: GL, job: "e2e", line: 3 });
  assertTrueValuesHaveEvidence(on);

  const manual = gitlab(`e2e:\n  script: [npx playwright test]\n  rules:\n    - if: $CI_PIPELINE_SOURCE == "merge_request_event"\n      when: manual\n`);
  assert.equal(manual.ci.runsOnMergeRequest, false);

  const never = gitlab(`e2e:\n  script: [npx playwright test]\n  rules:\n    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'\n      when: never\n    - if: $CI_PIPELINE_SOURCE == "push"\n`);
  assert.equal(never.ci.runsOnMergeRequest, false);

  const allowed = gitlab(`e2e:\n  script: [npx playwright test]\n  rules:\n    - if: $CI_PIPELINE_SOURCE == "merge_request_event"\n      allow_failure: true\n`);
  assert.equal(allowed.ci.runsOnMergeRequest, false, "a rule-level allow_failure: true is not a gate");
});

test("GitLab supported: plain schedule rules, only: lists and job-level when", () => {
  const sched = gitlab(`e2e:\n  script: [npx playwright test]\n  rules:\n    - if: $CI_PIPELINE_SOURCE == "merge_request_event"\n    - if: $CI_PIPELINE_SOURCE == "schedule"\n`);
  assert.equal(sched.ci.scheduledRun, true);
  assert.equal(sched.ci.runsOnMergeRequest, true);
  assertTrueValuesHaveEvidence(sched);

  const noSched = gitlab(`e2e:\n  script: [npx playwright test]\n  rules:\n    - if: $CI_PIPELINE_SOURCE == "schedule"\n      when: never\n    - if: $CI_PIPELINE_SOURCE == "merge_request_event"\n`);
  assert.equal(noSched.ci.scheduledRun, false);

  const only = gitlab(`e2e:\n  script: [npx playwright test]\n  only: [merge_requests, schedules]\n`);
  assert.equal(only.ci.runsOnMergeRequest, true);
  assert.equal(only.ci.scheduledRun, true);
  assertTrueValuesHaveEvidence(only);

  const onlyBlock = gitlab(`e2e:\n  script: [npx playwright test]\n  only:\n    - merge_requests\n`);
  assert.equal(onlyBlock.ci.runsOnMergeRequest, true);

  const jobManual = gitlab(`e2e:\n  when: manual\n  script: [npx playwright test]\n`);
  assert.equal(jobManual.ci.e2eJobs?.[0]?.manualOnly, true);
  assert.equal(jobManual.ci.runsOnMergeRequest, false);

  const jobNever = gitlab(`e2e:\n  when: never\n  script: [npx playwright test]\n`);
  assert.equal(jobNever.ci.e2eJobPresent, false);
});
