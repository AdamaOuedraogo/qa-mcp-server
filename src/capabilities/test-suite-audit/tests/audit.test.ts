import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { auditTestSuite } from "../evaluator.js";
import { analyseCi, analyseRunnerConfig, analyseSpec, readCapped, scanProject } from "../scanner.js";
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

// --- Review regressions (PR #3) ---------------------------------------------

test("assertion detection: nested callbacks, helper assertions and one-liners", () => {
  const src = [
    `import { test, expect } from "@playwright/test";`,
    `import { CheckoutPage } from "./pages/checkout.page";`,
    `test("nested callback still asserts", async ({ page }) => {`,
    `  await page.route("**/api", (route) => { route.fulfill({ status: 200 }); });`,
    `  await page.getByRole("button").click();`,
    `  await expect(page.getByText("ok")).toBeVisible();`,
    `});`,
    `test("asserts through a named helper", async ({ page }) => {`,
    `  const checkout = new CheckoutPage(page);`,
    `  await checkout.verifyTotal(42);`,
    `});`,
    `test("one-liner with expect", async ({ page }) => { await expect(page).toHaveURL(/cart/); });`,
    `test("one-liner without assertion", async ({ page }) => { await page.goto("/"); });`,
    `test("helper named like an action is not an assertion", async ({ page }) => {`,
    `  const checkout = new CheckoutPage(page);`,
    `  await checkout.confirmOrder();`,
    `});`,
  ].join("\n");
  const s = analyseSpec("tests/assertions.spec.ts", src);
  assert.equal(s.tests, 5);
  // Only the two tests that visibly assert nothing are counted; the limitation
  // (confirmOrder() may assert inside) is why COV-004 is labelled a heuristic.
  assert.equal(s.testsWithoutAssertion, 2);
});

test("COV-004 is labelled heuristic and stays below the deterministic rules", async () => {
  const obs = await scanProject(SAMPLE);
  const f = auditTestSuite(obs).findings.find((x) => x.id === "COV-004")!;
  assert.match(f.title, /heuristic/i);
  assert.ok(f.severity === "low" || f.severity === "medium");
  assert.equal(f.basis, "observed");
});

test("a caller-supplied observation cannot leak secrets through the judgment", () => {
  const spec = (over: Partial<TestSuiteObservation["specs"][number]>) => ({
    path: "tests/x.spec.ts",
    lines: 10,
    tests: 1,
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
    ...over,
  });
  const obs: TestSuiteObservation = {
    framework: "playwright",
    specs: [
      spec({
        hardcodedSecrets: [{ line: 3, snippet: `const token = "ghp_AbCdEf1234567890xyz";` }],
        hardWaits: [{ line: 4, snippet: `await page.waitForTimeout(500); // password: "hunter22hunter"` }],
        uiLoginSteps: [{ line: 5, snippet: `await page.fill("#password", "Sup3rSecret!");` }],
        fragileSelectors: [{ line: 6, snippet: `headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk" }` }],
      }),
    ],
    totalSpecFilesFound: 1,
    runnerConfig: { reporters: ["json"], baseUrlConfigured: true, storageStateOrSession: true, configFile: "playwright.config.ts" },
    ci: { provider: "gitlab", files: [".gitlab-ci.yml"], e2eJobPresent: true },
    repo: { typescript: true, lintConfigured: true, formatterConfigured: true, lockfile: true, e2eScript: true, testingReadme: true, pageObjectsDir: true, fixturesOrSeedDir: true, packageJsonFound: true },
    scanNotes: ["token=sk-live-0123456789abcdef"],
  };
  const text = JSON.stringify(auditTestSuite(obs));
  for (const leak of ["ghp_AbCdEf1234567890xyz", "hunter22hunter", "Sup3rSecret", "eyJhbGciOiJIUzI1NiJ9", "sk-live-0123456789abcdef"]) {
    assert.ok(!text.includes(leak), `leaked: ${leak}`);
  }
  assert.ok(text.includes("***"));
});

test("redactLine keeps ordinary evidence intact", async () => {
  const { redactLine } = await import("../redact.js");
  assert.equal(redactLine(`await page.locator("div > span").click();`), `await page.locator("div > span").click();`);
  assert.equal(redactLine(`await page.waitForTimeout(3000);`), `await page.waitForTimeout(3000);`);
  assert.equal(redactLine(`const password = "hunter22hunter";`), `const password = "***";`);
});

test("resolveInside rejects malformed input instead of cleaning it", () => {
  const root = "/absolute/path/to/project";
  assert.equal(resolveInside(root, "tests\u0000/../../etc"), undefined);
  assert.equal(resolveInside(root, "tests\n/e2e"), undefined);
  assert.equal(resolveInside(root, "C:\\\\Windows"), undefined);
  assert.equal(resolveInside(root, "\\\\\\\\server\\\\share"), undefined);
  assert.equal(resolveInside(root, "  tests/e2e  "), join(root, "tests/e2e"));
  assert.equal(resolveInside(root, "./tests/./e2e"), join(root, "tests/e2e"));
});

test("scanner does not follow symlinks and reports unreadable or truncated files", async () => {
  const { mkdtemp, writeFile, symlink, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const base = await mkdtemp(join(tmpdir(), "qa-audit-"));
  const dir = join(base, "project");
  const outside = join(base, "outside"); // sibling of the audited root, not under it
  try {
    await mkdir(join(dir, "tests"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(dir, "tests", "ok.spec.ts"), `test("a", async () => { expect(1).toBe(1); });`);
    await writeFile(join(dir, "tests", "big.spec.ts"), "// " + "x".repeat(2000) + "\n" + `test("b", async () => {});`);
    await writeFile(join(outside, "secret.spec.ts"), `test.only("escaped", async () => {});`);
    await symlink(outside, join(dir, "tests", "linked"));
    await symlink(join(outside, "secret.spec.ts"), join(dir, "tests", "linked.spec.ts"));
    const obs = await scanProject(dir, { maxFileBytes: 1024 });
    assert.deepEqual(obs.specs.map((s) => s.path).sort(), ["tests/big.spec.ts", "tests/ok.spec.ts"]);
    assert.ok(obs.scanNotes.some((n) => n.includes("big.spec.ts") && n.includes("truncated")));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("readCapped reads at most maxBytes and handles empty, small, exact and missing files", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "qa-audit-"));
  try {
    const notes: string[] = [];
    await writeFile(join(dir, "empty.ts"), "");
    await writeFile(join(dir, "small.ts"), "abc");
    await writeFile(join(dir, "exact.ts"), "x".repeat(16));
    await writeFile(join(dir, "big.ts"), "0123456789".repeat(10));
    assert.equal(await readCapped(join(dir, "empty.ts"), 16, notes, "empty.ts"), "");
    assert.equal(await readCapped(join(dir, "small.ts"), 16, notes, "small.ts"), "abc");
    assert.equal(await readCapped(join(dir, "exact.ts"), 16, notes, "exact.ts"), "x".repeat(16));
    assert.equal(notes.length, 0, "no note for files at or under the cap");
    assert.equal(await readCapped(join(dir, "big.ts"), 16, notes, "big.ts"), "0123456789012345");
    assert.equal(notes.length, 1);
    assert.equal(notes[0], "big.ts: truncated to 16 bytes.");
    assert.equal(await readCapped(join(dir, "missing.ts"), 16, notes, "missing.ts"), "");
    assert.match(notes[1] ?? "", /^missing\.ts: could not be read \(/);
    assert.equal(await readCapped(dir, 16, notes, "a-directory"), "");
    assert.match(notes[2] ?? "", /^a-directory: could not be read \(/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scanner reads only the capped prefix of an oversized file", async () => {
  // A sparse file larger than 2 GiB: an unbounded readFile() rejects it with
  // ERR_FS_FILE_TOO_LARGE, so this fails unless the read is bounded. Sparse
  // allocation keeps actual disk and memory use small.
  const { mkdtemp, writeFile, open, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "qa-audit-"));
  try {
    await mkdir(join(dir, "tests"));
    const file = join(dir, "tests", "huge.spec.ts");
    await writeFile(file, `test("huge", async () => { await page.waitForTimeout(500); });\n`);
    const fh = await open(file, "r+");
    await fh.truncate(2 ** 31 + 1024);
    await fh.close();
    const obs = await scanProject(dir, { maxFileBytes: 4096 });
    assert.deepEqual(obs.specs.map((s) => s.path), ["tests/huge.spec.ts"], "the capped prefix was analysed");
    assert.equal(obs.specs[0]!.hardWaits.length, 1, "signals in the prefix are still detected");
    assert.ok(obs.scanNotes.includes("tests/huge.spec.ts: truncated to 4096 bytes."));
    assert.ok(!obs.scanNotes.some((n) => n.includes("could not be read")), obs.scanNotes.join("\n"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("analyseCi ignores comments, image names and manual-only mentions", () => {
  const noJob = analyseCi([
    {
      path: ".gitlab-ci.yml",
      source: `# TODO: add playwright job\nbuild:\n  image: mcr.microsoft.com/playwright:v1.48.0-jammy\n  script:\n    - npm ci\n    - npm run build\n  rules:\n    - if: $CI_PIPELINE_SOURCE == "schedule"\n`,
    },
  ]);
  assert.equal(noJob.e2eJobPresent, false);
  assert.equal(noJob.scheduledRun, undefined, "no gate inference without a run command");

  const commentedOut = analyseCi([{ path: ".github/workflows/ci.yml", source: `jobs:\n  build:\n    steps:\n      # - run: npx playwright test\n      - run: npm test\n` }]);
  assert.equal(commentedOut.e2eJobPresent, false);

  const real = analyseCi([{ path: ".github/workflows/e2e.yml", source: `on:\n  pull_request:\n  schedule:\n    - cron: "0 2 * * *"\njobs:\n  e2e:\n    steps:\n      - run: npx playwright test --shard=\${{ matrix.shard }}\n      - uses: actions/upload-artifact@v4\n` }]);
  assert.equal(real.e2eJobPresent, true);
  assert.equal(real.runsOnMergeRequest, true);
  assert.equal(real.scheduledRun, true);
  assert.equal(real.artifactsPublished, true);
  assert.equal(real.parallelOrSharded, true);

  const script = analyseCi([{ path: ".gitlab-ci.yml", source: `e2e:\n  script:\n    - pnpm test:e2e\n` }]);
  assert.equal(script.e2eJobPresent, true);
});

test("missing config and CI are reported as not observed, with a completeness score", async () => {
  const { mkdtemp, writeFile, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "qa-audit-"));
  try {
    await mkdir(join(dir, "tests"));
    await writeFile(join(dir, "tests", "a.spec.ts"), `test("@p0 a", async ({ page }) => { await expect(page.getByRole("button")).toBeVisible(); });`);
    const j = auditTestSuite(await scanProject(dir));
    const ids = j.findings.map((f) => f.id);
    assert.ok(ids.includes("CFG-001"), "runner config not found is its own finding");
    assert.ok(!ids.includes("OBS-001") && !ids.includes("OBS-002") && !ids.includes("REL-004"), "config-dependent rules do not fire on an unobserved config");
    const ci = j.findings.find((f) => f.id === "COV-005")!;
    assert.equal(ci.basis, "not_observed");
    assert.notEqual(ci.severity, "critical");
    assert.ok(j.findings.filter((f) => f.basis === "not_observed").length >= 3);
    assert.ok(j.completeness.score < 0.5, `completeness should be low, got ${j.completeness.score}`);
    assert.equal(j.completeness.runnerConfigFound, false);
    assert.equal(j.completeness.ciDefinitionFound, false);
    assert.ok(j.summary.includes("completeness"));
    // Nothing observed is critical, so no axis is capped at 1 by the critical rule.
    assert.ok(j.findings.every((f) => f.severity !== "critical"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sample project: completeness is full and observed smells still cap the level", async () => {
  const j = auditTestSuite(await scanProject(SAMPLE));
  assert.equal(j.completeness.score, 1);
  assert.equal(j.completeness.notes.length, 0);
  assert.ok(j.overallLevel <= 1);
});
