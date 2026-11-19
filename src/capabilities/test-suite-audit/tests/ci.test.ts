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
  const start = lines.findIndex((l) => new RegExp(`^\\s*${job.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\s|$)`).test(l));
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
    if (ev.file.includes(".github/workflows") && (f === "runsOnMergeRequest" || f === "scheduledRun")) {
      // A GitHub gate is set by the workflow trigger: the evidence is the trigger line inside on:.
      const r = jobRange(source, "on");
      assert.ok(ev.line - 1 > r.start && ev.line - 1 < r.end || ev.line - 1 === r.start, `${f}: line ${ev.line} lies in on:`);
      assert.match(lines[ev.line - 1]!, f === "scheduledRun" ? /\bschedule\b/ : /\b(pull_request|pull_request_target|merge_group)\b/);
      continue;
    }
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

// --- GitHub steps: adversarial ------------------------------------------------

test("GitHub: run: under env: or with: is not a step command (review fixtures)", () => {
  const env = github(`on: [pull_request]\njobs:\n  e2e:\n    env:\n      run: npx playwright test\n    steps:\n      - run: echo hello\n`);
  assert.equal(env.ci.e2eJobPresent, false);
  assertNoPositiveClaim(env, ["runsOnMergeRequest"]);

  const withRun = github(`on: [pull_request]\njobs:\n  e2e:\n    steps:\n      - uses: actions/github-script@v7\n        with:\n          run: npx playwright test\n      - run: echo hello\n`);
  assert.equal(withRun.ci.e2eJobPresent, false);

  const usesInWith = github(`on: [pull_request]\njobs:\n  e2e:\n    steps:\n      - uses: actions/github-script@v7\n        with:\n          script: "uses: cypress-io/github-action"\n`);
  assert.equal(usesInWith.ci.e2eJobPresent, false);

  const jobLevelRun = github(`on: [pull_request]\njobs:\n  e2e:\n    run: npx playwright test\n    steps:\n      - run: echo hello\n`);
  assert.equal(jobLevelRun.ci.e2eJobPresent, false, "run: directly under the job is not a step");
});

test("GitHub: a disabled step does not count, a conditional or continue-on-error step is not a gate", () => {
  const off = github(`on: [pull_request]\njobs:\n  e2e:\n    steps:\n      - if: false\n        run: npx playwright test\n`);
  assert.equal(off.ci.e2eJobPresent, false);

  const cond = github(`on: [pull_request]\njobs:\n  e2e:\n    steps:\n      - if: github.event_name == 'schedule'\n        run: npx playwright test\n`);
  assert.equal(cond.ci.e2eJobPresent, true);
  assert.equal(cond.ci.runsOnMergeRequest, undefined);
  assert.equal(cond.ci.scheduledRun, undefined);
  assert.match(cond.ci.reasons?.runsOnMergeRequest ?? "", /own if:/);
  assertTrueValuesHaveEvidence(cond);

  const soft = github(`on: [pull_request]\njobs:\n  e2e:\n    steps:\n      - run: npx playwright test\n        continue-on-error: true\n`);
  assert.equal(soft.ci.runsOnMergeRequest, false);
});

test("GitHub: settings come from step uses/with only, and an unread action makes them undefined, never false", () => {
  const named = github(`on: [pull_request]\njobs:\n  e2e:\n    env:\n      NOTE: "uses: actions/upload-artifact and junit"\n    steps:\n      - name: no junit here\n        run: npx playwright test\n`);
  assert.equal(named.ci.artifactsPublished, false, "every step read, none uploads");
  assert.equal(named.ci.junitReportWired, undefined, "no known JUnit reporter: not established, not false");
  assert.match(named.ci.reasons?.junitReportWired ?? "", /known JUnit reporter/);

  const noCache = github(`on: [pull_request]\njobs:\n  e2e:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          cache: false\n      - run: npx playwright test\n`);
  assert.equal(noCache.ci.dependencyCache, false);

  const unknown = github(`on: [pull_request]\njobs:\n  e2e:\n    steps:\n      - uses: acme/test-kit@v2\n      - run: npx playwright test\n`);
  for (const f of ["artifactsPublished", "dependencyCache", "blanketJobRetry", "junitReportWired"] as const) {
    assert.equal(unknown.ci[f], undefined, `${f}: acme/test-kit was not read`);
  }
  assert.match(unknown.ci.reasons?.artifactsPublished ?? "", /acme\/test-kit/);
  assertTrueValuesHaveEvidence(unknown);
});

// --- GitHub steps: supported -------------------------------------------------

test("GitHub supported: run (scalar, literal and folded blocks), the Cypress action, and known step actions", () => {
  const o = github(
    `on: [pull_request]\njobs:\n  e2e:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          cache: pnpm\n      - run: |\n          pnpm install\n          npx playwright test\n      - uses: actions/upload-artifact@v4\n        if: always()\n      - uses: dorny/test-reporter@v1\n      - uses: nick-fields/retry@v3\n`,
  );
  assert.equal(o.ci.e2eJobPresent, true);
  assert.deepEqual(o.ci.evidence?.e2eJobPresent, { file: GH, job: "e2e", line: 11 });
  assert.equal(o.ci.runsOnMergeRequest, true);
  assert.equal(o.ci.artifactsPublished, true);
  assert.equal(o.ci.junitReportWired, true);
  assert.equal(o.ci.blanketJobRetry, true);
  assert.equal(o.ci.dependencyCache, true);
  assertTrueValuesHaveEvidence(o);

  const folded = github(`on: [pull_request]\njobs:\n  e2e:\n    steps:\n      - run: >\n          npx playwright\n          test\n`);
  assert.equal(folded.ci.e2eJobPresent, true, "a folded scalar joins its lines");

  const cy = github(`on: [pull_request]\njobs:\n  e2e:\n    steps:\n      - uses: cypress-io/github-action@v6\n`);
  assert.equal(cy.ci.e2eJobPresent, true);
  assertTrueValuesHaveEvidence(cy);
});

// --- Command recognition: adversarial -----------------------------------------

test("commands: install, open, echo and --list are not test runs", () => {
  for (const cmd of [
    "pnpm playwright install --with-deps",
    "npx playwright install chromium",
    "pnpm cypress open",
    "npx cypress verify",
    'echo "remember to run playwright test"',
    "npx playwright test --list",
    "npx playwright test --help",
    "npx cypress run --version",
    "pnpm ui",
    "npm run playwright",
  ]) {
    const o = gitlab(`job:\n  script:\n    - ${cmd}\n`);
    assert.equal(o.ci.e2eJobPresent, false, cmd);
    assertTrueValuesHaveEvidence(o);
  }
});

test("comments: a # inside quotes is not a comment; a commented-out command is not a command", () => {
  const quoted = gitlab(`e2e:\n  script:\n    - echo "step #1" && npx playwright test\n`);
  assert.equal(quoted.ci.e2eJobPresent, true);
  assertTrueValuesHaveEvidence(quoted);

  const commented = gitlab(`e2e:\n  script:\n    - npm ci # && npx playwright test\n`);
  assert.equal(commented.ci.e2eJobPresent, false);

  const apostrophe = gitlab(`e2e:\n  script:\n    - echo don't # npx playwright test\n`);
  assert.equal(apostrophe.ci.e2eJobPresent, false, "an apostrophe in a word does not open a quote");
});

// --- Command recognition: supported ------------------------------------------

test("commands supported: direct runs in command position, continuations, chained commands, env prefixes", () => {
  for (const cmd of [
    "npx playwright test",
    "pnpm exec playwright test --shard=1/4",
    "yarn playwright test",
    "bunx playwright test",
    "./node_modules/.bin/playwright test",
    "CI=1 HOME=/tmp npx playwright test",
    "npm ci && npx playwright test",
    "npx cypress run --browser chrome",
  ]) {
    const o = gitlab(`e2e:\n  script:\n    - ${cmd}\n`);
    assert.equal(o.ci.e2eJobPresent, true, cmd);
    assert.equal(o.ci.e2eJobs?.[0]?.basis, "observed", cmd);
    assertTrueValuesHaveEvidence(o);
  }
  const cont = gitlab(`e2e:\n  script:\n    - npx playwright \\\n      test --project=chromium\n`);
  assert.equal(cont.ci.e2eJobPresent, true, "a backslash continuation is joined");
});

test("commands supported: a package script named e2e is an inferred E2E job, and findings on it carry basis inferred", async () => {
  for (const cmd of ["pnpm test:e2e", "npm run e2e", "yarn e2e:ci", "pnpm run test:e2e:headless", "bun run e2e"]) {
    const o = gitlab(`e2e:\n  script:\n    - ${cmd}\n`);
    assert.equal(o.ci.e2eJobPresent, true, cmd);
    assert.equal(o.ci.e2eJobs?.[0]?.basis, "inferred", cmd);
  }
  const { auditTestSuite } = await import("../evaluator.js");
  const o = gitlab(`e2e:\n  script:\n    - pnpm test:e2e\n`);
  const j = auditTestSuite({
    framework: "playwright",
    specs: [],
    totalSpecFilesFound: 25,
    runnerConfig: { reporters: ["json"], baseUrlConfigured: true, storageStateOrSession: true, configFile: "playwright.config.ts" },
    ci: o.ci,
    repo: {
      typescript: true,
      lintConfigured: true,
      formatterConfigured: true,
      lockfile: true,
      e2eScript: true,
      testingReadme: true,
      pageObjectsDir: true,
      fixturesOrSeedDir: true,
      packageJsonFound: true,
    },
    scanNotes: [],
  });
  const obs003 = j.findings.find((f) => f.id === "OBS-003");
  assert.equal(o.ci.artifactsPublished, false);
  assert.equal(obs003?.basis, "inferred", "the job itself was only inferred from a script name");
});

// --- Setting semantics: false only when the carrier was fully read ------------

test("sharding: concurrency without a shard argument, or an unread script, is not established", () => {
  const glPar = gitlab(`e2e:\n  parallel: 4\n  script: [npx playwright test]\n`);
  assert.equal(glPar.ci.parallelOrSharded, undefined);
  assert.match(glPar.ci.reasons?.parallelOrSharded ?? "", /parallel: 4 without a shard argument/);

  const ghMatrix = github(`on: [pull_request]\njobs:\n  e2e:\n    strategy:\n      matrix:\n        node: [18, 20]\n    steps:\n      - run: npx playwright test\n`);
  assert.equal(ghMatrix.ci.parallelOrSharded, undefined);

  const script = gitlab(`e2e:\n  script: [pnpm test:e2e]\n`);
  assert.equal(script.ci.parallelOrSharded, undefined, "the script body may shard; it was not read");
  assert.match(script.ci.reasons?.parallelOrSharded ?? "", /package script/);
  assertNoPositiveClaim(script, ["parallelOrSharded"]);
});

test("JUnit, retry and cache on GitLab: unsupported forms abstain, limited retries are not blanket", () => {
  const flowArt = gitlab(`e2e:\n  script: [npx playwright test]\n  artifacts: {reports: {junit: report.xml}}\n`);
  assert.equal(flowArt.ci.junitReportWired, undefined);
  assert.equal(flowArt.ci.artifactsPublished, true, "the artifacts key is there");
  assertTrueValuesHaveEvidence(flowArt);

  const pathsOnly = gitlab(`e2e:\n  script: [npx playwright test]\n  artifacts:\n    paths: [junit.xml]\n`);
  assert.equal(pathsOnly.ci.junitReportWired, false, "a file named junit.xml in paths is not artifacts:reports:junit");

  const infraRetry = gitlab(`e2e:\n  script: [npx playwright test]\n  retry:\n    max: 2\n    when: [runner_system_failure, stuck_or_timeout_failure]\n`);
  assert.equal(infraRetry.ci.blanketJobRetry, false, "retries infrastructure failures only");

  const flowRetry = gitlab(`e2e:\n  script: [npx playwright test]\n  retry: {max: 2, when: [runner_system_failure]}\n`);
  assert.equal(flowRetry.ci.blanketJobRetry, undefined);
  assert.match(flowRetry.ci.reasons?.blanketJobRetry ?? "", /unsupported form/);

  const noCache = gitlab(`e2e:\n  script: [npx playwright test]\n  cache: []\n`);
  assert.equal(noCache.ci.dependencyCache, false, "cache: [] disables caching");
  const flowCache = gitlab(`e2e:\n  script: [npx playwright test]\n  cache: {key: x, paths: [node_modules]}\n`);
  assert.equal(flowCache.ci.dependencyCache, undefined);
});

test("settings supported: shard arguments, Cypress parallel, reports:junit, retry forms and cache blocks", () => {
  const gl = gitlab(
    `e2e:\n  parallel: 3\n  script:\n    - npx playwright test --shard=$CI_NODE_INDEX/$CI_NODE_TOTAL\n  artifacts:\n    when: always\n    reports:\n      junit: results.xml\n  retry:\n    max: 2\n    when: script_failure\n  cache:\n    paths: [node_modules]\n`,
  );
  assert.equal(gl.ci.parallelOrSharded, true);
  assert.equal(gl.ci.junitReportWired, true);
  assert.equal(gl.ci.blanketJobRetry, true);
  assert.equal(gl.ci.dependencyCache, true);
  assert.equal(gl.ci.artifactsPublished, true);
  assertTrueValuesHaveEvidence(gl);

  const plain = gitlab(`e2e:\n  script: [npx playwright test]\n  retry: 1\n`);
  assert.equal(plain.ci.blanketJobRetry, true);
  assert.equal(plain.ci.parallelOrSharded, false, "a direct command with no concurrency and no shard argument");
  assert.equal(gitlab(`e2e:\n  script: [npx playwright test]\n  retry: 0\n`).ci.blanketJobRetry, false);

  const cy = github(`on: [pull_request]\njobs:\n  e2e:\n    steps:\n      - uses: cypress-io/github-action@v6\n        with:\n          parallel: true\n          record: true\n`);
  assert.equal(cy.ci.parallelOrSharded, true);
  assertTrueValuesHaveEvidence(cy);

  const cyCli = gitlab(`e2e:\n  parallel: 2\n  script: [npx cypress run --record --parallel]\n`);
  assert.equal(cyCli.ci.parallelOrSharded, true);
  assertTrueValuesHaveEvidence(cyCli);
});
