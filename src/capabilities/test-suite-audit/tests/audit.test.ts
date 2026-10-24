import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { auditTestSuite } from "../evaluator.js";
import { analyseCi, analyseRunnerConfig, analyseSpec, scanProject } from "../scanner.js";
import { resolveInside } from "../tool.js";
import type { TestSuiteObservation } from "../schema.js";

/**
 * These tests pin the *expertise* (what a senior QA flags, and how hard) and
 * the scanner's honesty (what it reports, what it refuses). Run with:
 *   node --import tsx --test src/capabilities/test-suite-audit/tests/*.test.ts
 */

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(here, "..", "fixtures", "sample-project");

// --- Scanner -----------------------------------------------------------------

test("analyseSpec detects the classic smells with line numbers", () => {
  const src = [
    `import { test, expect } from "@playwright/test";`,
    `test.only("logs in", async ({ page }) => {`,
    `  await page.goto("https://staging.example.net/login");`,
    `  await page.fill("#password", "hunter22hunter");`,
    `  await page.click("//button[@type='submit']");`,
    `  await page.waitForTimeout(2000);`,
    `  await page.locator(".a .b").click({ force: true });`,
    `  if (await page.locator(".modal").isVisible()) {`,
    `  }`,
    `});`,
    `test.skip("later", async () => {});`,
    `test("@p0 checks", async ({ page }) => { await expect(page.getByRole("button")).toBeVisible(); });`,
  ].join("\n");
  const s = analyseSpec("tests/login.spec.ts", src);
  assert.equal(s.tests, 3);
  assert.equal(s.hardWaits.length, 1);
  assert.equal(s.hardWaits[0]!.line, 6);
  assert.equal(s.focusedTests.length, 1);
  assert.equal(s.skippedTests.length, 1);
  assert.equal(s.forcedActions.length, 1);
  assert.ok(s.fragileSelectors.length >= 2, "xpath + class chain");
  assert.equal(s.hardcodedSecrets.length, 1);
  assert.ok(s.hardcodedSecrets[0]!.snippet.includes("***"), "secret is masked in evidence");
  assert.equal(s.hardcodedUrls.length, 1);
  assert.equal(s.uiLoginSteps.length, 1);
  assert.equal(s.conditionalFlow.length, 1);
  assert.equal(s.usesSemanticLocators, true);
  assert.deepEqual(s.priorityTags, ["@p0"]);
  // "logs in" has no expect; "later" is empty; "@p0 checks" asserts.
  assert.equal(s.testsWithoutAssertion, 2);
});

test("analyseRunnerConfig reads Playwright retries/reporters/trace and the CI ternary", () => {
  const cfg = `export default defineConfig({ retries: process.env.CI ? 2 : 0, fullyParallel: true, workers: '50%',
    reporter: [['html'], ['json', { outputFile: 'r.json' }], ['junit', { outputFile: 'r.xml' }]],
    use: { baseURL: 'http://localhost:3000', trace: 'retain-on-failure', screenshot: 'only-on-failure', testIdAttribute: 'data-cy' } });`;
  const c = analyseRunnerConfig("playwright.config.ts", cfg, "playwright");
  assert.equal(c.retries, 2);
  assert.equal(c.fullyParallel, true);
  assert.equal(c.workers, "50%");
  assert.deepEqual(c.reporters, ["html", "json", "junit"]);
  assert.equal(c.traceOnFailure, true);
  assert.equal(c.screenshotOnFailure, true);
  assert.equal(c.baseUrlConfigured, true);
  assert.equal(c.testIdAttributeConfigured, true);
});

test("analyseCi recognises a GitLab pipeline with sharding, artifacts and blanket retry", () => {
  const ci = analyseCi([
    {
      path: ".gitlab-ci.yml",
      source: `e2e:\n  retry: 2\n  parallel: 4\n  script: [npx playwright test --shard=$CI_NODE_INDEX/$CI_NODE_TOTAL]\n  artifacts:\n    when: always\n    reports:\n      junit: results.xml\n  rules:\n    - if: $CI_PIPELINE_SOURCE == "merge_request_event"\n    - if: $CI_PIPELINE_SOURCE == "schedule"\n`,
    },
  ]);
  assert.equal(ci.provider, "gitlab");
  assert.equal(ci.e2eJobPresent, true);
  assert.equal(ci.parallelOrSharded, true);
  assert.equal(ci.artifactsPublished, true);
  assert.equal(ci.junitReportWired, true);
  assert.equal(ci.blanketJobRetry, true);
  assert.equal(ci.scheduledRun, true);
  assert.equal(ci.runsOnMergeRequest, true);
});

test("scanProject walks the sample project and reports an honest observation", async () => {
  const obs = await scanProject(SAMPLE);
  assert.equal(obs.framework, "playwright");
  assert.equal(obs.specs.length, 2);
  assert.equal(obs.totalSpecFilesFound, 2);
  assert.equal(obs.runnerConfig.retries, 3);
  assert.deepEqual(obs.runnerConfig.reporters, ["html"]);
  assert.equal(obs.runnerConfig.traceOnFailure, false);
  assert.equal(obs.ci.provider, "gitlab");
  assert.equal(obs.ci.e2eJobPresent, true);
  assert.equal(obs.ci.blanketJobRetry, true);
  assert.equal(obs.repo.typescript, true);
  assert.equal(obs.repo.lockfile, false);
  assert.equal(obs.repo.pageObjectsDir, true);
  const checkout = obs.specs.find((s) => s.path.endsWith("checkout.spec.ts"))!;
  assert.equal(checkout.usesPageObjectOrFixture, true);
  assert.deepEqual(checkout.priorityTags, ["@p0"]);
});

test("scanProject tolerates a missing directory instead of throwing", async () => {
  const obs = await scanProject(join(SAMPLE, "does-not-exist"));
  assert.equal(obs.specs.length, 0);
  assert.equal(obs.framework, "unknown");
});

// --- Expertise ---------------------------------------------------------------

test("sample project: critical findings, hotspots and a phased plan", async () => {
  const obs = await scanProject(SAMPLE);
  const j = auditTestSuite(obs);

  const ids = j.findings.map((f) => f.id);
  assert.ok(ids.includes("COV-003"), ".only is flagged as critical");
  assert.ok(ids.includes("GOV-001"), "hard-coded secret is flagged");
  assert.ok(ids.includes("REL-001"), "hard wait is flagged");
  assert.ok(ids.includes("REL-004"), "retries + CI job retry are flagged");
  assert.ok(ids.includes("OBS-001"), "html-only reporter is flagged");
  assert.ok(ids.includes("OBS-002"), "trace off is flagged");
  assert.ok(ids.includes("GOV-004"), "missing lockfile is flagged");
  assert.ok(!ids.includes("COV-005"), "CI gate exists");
  assert.ok(!ids.includes("MNT-003"), "pages/ directory counts as an abstraction layer");

  assert.equal(j.findings[0]!.severity, "critical", "findings are sorted by severity");
  assert.ok(j.overallLevel <= 1, `critical findings cap the level, got ${j.overallLevel}`);
  const cov = j.axes.find((a) => a.axis === "coverage_and_risk")!;
  assert.ok(cov.level <= 1, "a committed .only caps coverage at ad hoc");

  assert.equal(j.hotspots[0]!.path, "tests/e2e/login.spec.ts", "login spec is the top hotspot");
  assert.ok(j.quickWinCount >= 5);

  const phases = new Set(j.actionPlan.map((a) => a.phase));
  assert.deepEqual([...phases].sort(), ["adopt", "diagnose", "prototype"]);
  const critPlan = j.actionPlan.find((a) => a.phase === "prototype" && a.findingIds.includes("COV-003"));
  assert.ok(critPlan && critPlan.priority === "now", "critical fixes are the first prototype action");

  // Evidence cites real file:line pairs.
  const only = j.findings.find((f) => f.id === "COV-003")!;
  assert.equal(only.evidence[0]!.file, "tests/e2e/login.spec.ts");
  assert.equal(only.evidence[0]!.line, 4);
  // Secrets never leak into the audit output.
  assert.ok(!JSON.stringify(j).includes("Sup3rSecret"));
});

test("a mature suite scores managed/optimized with no critical findings", () => {
  const spec = (path: string) => ({
    path,
    lines: 80,
    tests: 4,
    hardWaits: [],
    focusedTests: [],
    skippedTests: [],
    forcedActions: [],
    fragileSelectors: [],
    conditionalFlow: [],
    hardcodedSecrets: [],
    hardcodedUrls: [],
    uiLoginSteps: [],
    testsWithoutAssertion: 0,
    usesSemanticLocators: true,
    usesPageObjectOrFixture: true,
    priorityTags: ["@p0"],
  });
  const obs: TestSuiteObservation = {
    framework: "playwright",
    specs: Array.from({ length: 30 }, (_, i) => spec(`tests/journey-${i}.spec.ts`)),
    totalSpecFilesFound: 30,
    runnerConfig: {
      configFile: "playwright.config.ts",
      retries: 1,
      workers: "50%",
      fullyParallel: true,
      reporters: ["html", "json", "junit"],
      traceOnFailure: true,
      screenshotOnFailure: true,
      baseUrlConfigured: true,
      testIdAttributeConfigured: true,
      storageStateOrSession: true,
      projects: 2,
    },
    ci: {
      provider: "gitlab",
      files: [".gitlab-ci.yml"],
      e2eJobPresent: true,
      runsOnMergeRequest: true,
      scheduledRun: true,
      artifactsPublished: true,
      junitReportWired: true,
      parallelOrSharded: true,
      blanketJobRetry: false,
      dependencyCache: true,
    },
    repo: {
      typescript: true,
      tsStrict: true,
      lintConfigured: true,
      formatterConfigured: true,
      lockfile: true,
      e2eScript: true,
      testingReadme: true,
      pageObjectsDir: true,
      fixturesOrSeedDir: true,
    },
    scanNotes: [],
  };
  const j = auditTestSuite(obs);
  assert.equal(j.findings.filter((f) => f.severity === "critical").length, 0);
  assert.equal(j.findings.filter((f) => f.severity === "high").length, 0);
  assert.ok(j.overallLevel >= 3, `expected managed or better, got ${j.overallLevel}`);
  assert.equal(j.hotspots.length, 0);
  assert.ok(j.findings.length <= 2, `a mature suite should have at most minor remarks, got ${j.findings.map((f) => f.id)}`);
});

test("the judgment is deterministic", async () => {
  const obs = await scanProject(SAMPLE);
  assert.deepEqual(auditTestSuite(obs), auditTestSuite(obs));
});

// --- Tool boundary -----------------------------------------------------------

test("resolveInside confines the audit to the configured root", () => {
  const root = "/absolute/path/to/project";
  assert.equal(resolveInside(root, undefined), root);
  assert.equal(resolveInside(root, "tests/e2e"), join(root, "tests/e2e"));
  assert.equal(resolveInside(root, "../other"), undefined);
  assert.equal(resolveInside(root, "tests/../../etc"), undefined);
  assert.equal(resolveInside(root, "/etc"), undefined);
});
