import type {
  Axis,
  AxisScore,
  EvidenceRef,
  Finding,
  Hotspot,
  Occurrence,
  PlannedAction,
  Severity,
  SpecObservation,
  TestSuiteObservation,
} from "./schema.js";

/**
 * The expertise.
 *
 * This file encodes how a senior QA consultant reads a test suite in the first
 * days of an engagement: which smells matter, how much, what they cost the
 * team, and what to fix first. Each rule is a pure function from the
 * observation to zero or one finding. The scorer then turns findings into a
 * maturity level per axis; the planner turns them into a phased action plan.
 *
 * The prose spec lives in ./docs/reasoning.md. Keep the two in sync.
 */

const MAX_EVIDENCE = 8;

// --- Helpers ---------------------------------------------------------------

function sumOcc(specs: SpecObservation[], pick: (s: SpecObservation) => Occurrence[]): number {
  return specs.reduce((n, s) => n + pick(s).length, 0);
}

function evidenceFrom(specs: SpecObservation[], pick: (s: SpecObservation) => Occurrence[]): EvidenceRef[] {
  const out: EvidenceRef[] = [];
  for (const s of specs) {
    for (const o of pick(s)) {
      if (out.length >= MAX_EVIDENCE) return out;
      out.push({ file: s.path, line: o.line, snippet: o.snippet });
    }
  }
  return out;
}

function filesWith(specs: SpecObservation[], pick: (s: SpecObservation) => Occurrence[]): number {
  return specs.filter((s) => pick(s).length > 0).length;
}

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

type Rule = (obs: TestSuiteObservation) => Finding | undefined;

// --- Reliability -------------------------------------------------------------

const hardWaits: Rule = (obs) => {
  const n = sumOcc(obs.specs, (s) => s.hardWaits);
  if (n === 0) return undefined;
  const files = filesWith(obs.specs, (s) => s.hardWaits);
  const share = pct(files, obs.specs.length);
  const severity: Severity = share >= 30 || n >= 20 ? "high" : n >= 5 ? "medium" : "low";
  return {
    id: "REL-001",
    axis: "reliability",
    severity,
    title: "Fixed sleeps used for synchronisation",
    observation: `${n} hard wait(s) in ${files} spec file(s) (${share}% of the suite).`,
    impact:
      "Sleeps are the single most common source of flake: too short on a slow runner, too long everywhere else. They inflate pipeline time and still fail intermittently.",
    recommendation:
      "Replace each sleep with a web-first assertion or an explicit wait on the condition the test actually needs (element state, network response, URL). Treat any remaining sleep as a documented exception.",
    effort: n <= 10 ? "S" : "M",
    quickWin: true,
    basis: "observed",
    evidence: evidenceFrom(obs.specs, (s) => s.hardWaits),
    occurrences: n,
  };
};

const forcedActions: Rule = (obs) => {
  const n = sumOcc(obs.specs, (s) => s.forcedActions);
  if (n === 0) return undefined;
  return {
    id: "REL-002",
    axis: "reliability",
    severity: n >= 10 ? "medium" : "low",
    title: "Actionability checks bypassed with { force: true }",
    observation: `${n} forced action(s) in ${filesWith(obs.specs, (s) => s.forcedActions)} file(s).`,
    impact:
      "`force: true` clicks elements a user could not click (hidden, covered, animating). The test passes while the product is broken, or fails for reasons the trace cannot explain.",
    recommendation:
      "Remove the force flag and fix the underlying cause: wait for the overlay to disappear, scroll into view, or raise a product bug if the element is genuinely unreachable.",
    effort: "S",
    quickWin: true,
    basis: "observed",
    evidence: evidenceFrom(obs.specs, (s) => s.forcedActions),
    occurrences: n,
  };
};

const conditionalFlow: Rule = (obs) => {
  const n = sumOcc(obs.specs, (s) => s.conditionalFlow);
  if (n === 0) return undefined;
  return {
    id: "REL-003",
    axis: "reliability",
    severity: n >= 15 ? "medium" : "low",
    title: "Conditional logic inside test bodies",
    observation: `${n} if/else or try/catch block(s) inside tests, across ${filesWith(obs.specs, (s) => s.conditionalFlow)} file(s).`,
    impact:
      "A test with branches has no single expected outcome. It typically hides a non-deterministic UI state (a modal that sometimes appears) and silently skips assertions on one branch.",
    recommendation:
      "Make the precondition deterministic (seed data, mock the feature flag, dismiss the modal in setup) and write one straight-line test per scenario.",
    effort: "M",
    quickWin: false,
    basis: "observed",
    evidence: evidenceFrom(obs.specs, (s) => s.conditionalFlow),
    occurrences: n,
  };
};

const retriesMaskFlake: Rule = (obs) => {
  if (!obs.runnerConfig.configFile && !obs.ci.blanketJobRetry) return undefined;
  const r = obs.runnerConfig.retries;
  const blanket = obs.ci.blanketJobRetry;
  if ((r === undefined || r <= 1) && !blanket) return undefined;
  const parts: string[] = [];
  if (r !== undefined && r >= 2) parts.push(`runner retries = ${r}`);
  if (blanket) parts.push("CI retries the whole job");
  return {
    id: "REL-004",
    axis: "reliability",
    severity: blanket ? "high" : "medium",
    title: "Retries configured as a substitute for stability",
    observation: parts.join("; ") + ".",
    impact:
      "Retries turn flake into invisible cost: the pipeline is green, the run is 2–3× longer, and nobody is told which tests are unreliable. Job-level retries also re-run real regressions.",
    recommendation:
      "Keep at most one retry on CI, emit a JSON/JUnit report that records retries, and triage every retried test (the `triage_flaky_test` capability does this). Remove job-level retry.",
    effort: "S",
    quickWin: true,
    basis: "observed",
    evidence: obs.runnerConfig.configFile ? [{ file: obs.runnerConfig.configFile }] : [],
    occurrences: 1,
  };
};

const uiLoginEverywhere: Rule = (obs) => {
  const n = sumOcc(obs.specs, (s) => s.uiLoginSteps);
  const files = filesWith(obs.specs, (s) => s.uiLoginSteps);
  if (files < 2 || obs.runnerConfig.storageStateOrSession) return undefined;
  return {
    id: "REL-005",
    axis: "reliability",
    severity: files >= 5 ? "high" : "medium",
    title: "Authentication performed through the UI in every spec",
    observation: `${files} spec file(s) type credentials through the login form (${n} occurrence(s)); no storageState / cy.session / global setup detected.`,
    impact:
      "Login is the slowest and most rate-limited step of a suite. Repeating it per test multiplies runtime and couples every test to the login page's stability.",
    recommendation:
      "Authenticate once in a setup project (Playwright storageState) or cache the session (cy.session) and reuse it. Keep one dedicated login test.",
    effort: "M",
    quickWin: true,
    basis: "observed",
    evidence: evidenceFrom(obs.specs, (s) => s.uiLoginSteps),
    occurrences: n,
  };
};

// --- Maintainability ---------------------------------------------------------

const fragileSelectors: Rule = (obs) => {
  const n = sumOcc(obs.specs, (s) => s.fragileSelectors);
  if (n === 0) return undefined;
  const files = filesWith(obs.specs, (s) => s.fragileSelectors);
  const share = pct(files, obs.specs.length);
  return {
    id: "MNT-001",
    axis: "maintainability",
    severity: share >= 40 ? "high" : share >= 15 ? "medium" : "low",
    title: "Brittle selectors (XPath, positional or structural CSS)",
    observation: `${n} brittle selector(s) in ${files} file(s) (${share}% of the suite).`,
    impact:
      "Structural selectors break on every layout change, so the team spends its time repairing tests instead of extending coverage — the fastest way to lose trust in a suite.",
    recommendation:
      "Move to role/label/text locators first and `data-testid` second. Agree the test-id convention with developers and set `testIdAttribute` in the config.",
    effort: n <= 15 ? "S" : "M",
    quickWin: n <= 15,
    basis: "observed",
    evidence: evidenceFrom(obs.specs, (s) => s.fragileSelectors),
    occurrences: n,
  };
};

const noSemanticLocators: Rule = (obs) => {
  if (obs.specs.length === 0) return undefined;
  const with_ = obs.specs.filter((s) => s.usesSemanticLocators).length;
  const share = pct(with_, obs.specs.length);
  if (share >= 50) return undefined;
  return {
    id: "MNT-002",
    axis: "maintainability",
    severity: share === 0 ? "medium" : "low",
    title: "Few specs use user-facing locators",
    observation: `Only ${with_} of ${obs.specs.length} spec file(s) (${share}%) use getByRole/getByLabel/getByTestId-style locators.`,
    impact: "Tests that do not locate elements the way a user does are harder to read, harder to review and break for cosmetic reasons.",
    recommendation: "Adopt a locator standard (role > label > text > test-id > CSS) and apply it in every new or touched test; enforce it in code review.",
    effort: "M",
    quickWin: false,
    basis: "observed",
    evidence: [],
    occurrences: obs.specs.length - with_,
  };
};

const noAbstraction: Rule = (obs) => {
  if (obs.specs.length < 5) return undefined;
  const with_ = obs.specs.filter((s) => s.usesPageObjectOrFixture).length;
  const share = pct(with_, obs.specs.length);
  if (share >= 40 || obs.repo.pageObjectsDir) return undefined;
  return {
    id: "MNT-003",
    axis: "maintainability",
    severity: "medium",
    title: "No shared abstraction layer (page objects, fixtures or custom commands)",
    observation: `${with_} of ${obs.specs.length} specs (${share}%) import a page object, fixture or command module; no page-objects directory found.`,
    impact: "Every flow is re-implemented in each spec, so one UI change means N edits — and N chances to diverge.",
    recommendation: "Introduce thin fixtures/page objects for the 3–5 most repeated flows (login, navigation, form submission). Keep them small: encapsulate locators and actions, not assertions.",
    effort: "M",
    quickWin: false,
    basis: "observed",
    evidence: [],
    occurrences: obs.specs.length - with_,
  };
};

const hardcodedUrls: Rule = (obs) => {
  const n = sumOcc(obs.specs, (s) => s.hardcodedUrls);
  if (n === 0) return undefined;
  return {
    id: "MNT-004",
    axis: "maintainability",
    severity: obs.runnerConfig.baseUrlConfigured ? "low" : "medium",
    title: "Environment URLs hard-coded in tests",
    observation: `${n} absolute URL(s) in ${filesWith(obs.specs, (s) => s.hardcodedUrls)} file(s); baseURL ${obs.runnerConfig.baseUrlConfigured ? "is" : "is not"} configured.`,
    impact: "The suite cannot be pointed at another environment (preview, staging, prod-like) without editing tests, which blocks running it where it is most useful.",
    recommendation: "Use relative paths with a configured baseURL per environment (an env var or a project per target).",
    effort: "S",
    quickWin: true,
    basis: "observed",
    evidence: evidenceFrom(obs.specs, (s) => s.hardcodedUrls),
    occurrences: n,
  };
};

const largeSpecs: Rule = (obs) => {
  const big = obs.specs.filter((s) => s.lines > 400 || s.tests > 25);
  if (big.length === 0) return undefined;
  return {
    id: "MNT-005",
    axis: "maintainability",
    severity: big.length >= 5 ? "medium" : "low",
    title: "Oversized spec files",
    observation: `${big.length} spec file(s) exceed 400 lines or 25 tests (largest: ${Math.max(...big.map((s) => s.lines))} lines).`,
    impact: "Large files hide duplicated setup, slow down review and are where shared state between tests creeps in.",
    recommendation: "Split by user journey or feature; move shared setup to fixtures. Target one journey per file.",
    effort: "M",
    quickWin: false,
    basis: "observed",
    evidence: big.slice(0, MAX_EVIDENCE).map((s) => ({ file: s.path, snippet: `${s.lines} lines, ${s.tests} tests` })),
    occurrences: big.length,
  };
};

const noTypeSafety: Rule = (obs) => {
  if (!obs.repo.typescript) {
    return {
      id: "MNT-006",
      axis: "maintainability",
      severity: "low",
      title: "Test code is not typed",
      observation: "No tsconfig.json and no TypeScript spec files detected.",
      impact: "Refactoring page objects and fixtures without types is slow and error-prone; editor support for Playwright/Cypress APIs is lost.",
      recommendation: "Migrate incrementally to TypeScript (rename + minimal types first), starting with shared modules.",
      effort: "L",
      quickWin: false,
      basis: "observed",
      evidence: [],
      occurrences: 1,
    };
  }
  if (obs.repo.tsStrict === false) {
    return {
      id: "MNT-006",
      axis: "maintainability",
      severity: "low",
      title: "TypeScript strict mode disabled for tests",
      observation: "tsconfig.json present but `strict` is not true.",
      impact: "Nullable locators and loose fixture types let silent mistakes through to CI.",
      recommendation: "Enable `strict` for the test project; fix errors file by file.",
      effort: "S",
      quickWin: true,
      basis: "observed",
      evidence: [{ file: "tsconfig.json" }],
      occurrences: 1,
    };
  }
  return undefined;
};

const noLint: Rule = (obs) => {
  if (obs.repo.lintConfigured) return undefined;
  return {
    id: "MNT-007",
    axis: "maintainability",
    severity: "low",
    title: "No linter configured for test code",
    observation: "No ESLint/Biome configuration or dependency found.",
    impact: "Standards (no `.only`, no floating promises, locator conventions) are not enforced automatically, so they erode.",
    recommendation: "Add ESLint with the Playwright (or Cypress) plugin and the `no-floating-promises` rule; run it in CI.",
    effort: "S",
    quickWin: true,
    basis: "not_observed",
    evidence: [],
    occurrences: 1,
  };
};

// --- Feedback speed ----------------------------------------------------------

const noParallelism: Rule = (obs) => {
  if (obs.framework === "cypress" || !obs.runnerConfig.configFile) return undefined; // Cypress parallelism is a cloud/CI concern (handled by SPD-002)
  const { fullyParallel, workers } = obs.runnerConfig;
  if (fullyParallel || (typeof workers === "number" && workers > 1) || typeof workers === "string") return undefined;
  if (obs.specs.length < 10) return undefined;
  return {
    id: "SPD-001",
    axis: "feedback_speed",
    severity: "medium",
    title: "Suite runs serially",
    observation: `${obs.specs.length} spec files; fullyParallel is not enabled and workers is ${workers ?? "default"}.`,
    impact: "Feedback time grows linearly with coverage, so adding tests makes the pipeline slower and teams start skipping it.",
    recommendation: "Enable fullyParallel, make tests independent (own data, no shared order), then shard across CI jobs.",
    effort: "M",
    quickWin: false,
    basis: "observed",
    evidence: obs.runnerConfig.configFile ? [{ file: obs.runnerConfig.configFile }] : [],
    occurrences: 1,
  };
};

const ciNotSharded: Rule = (obs) => {
  if (!obs.ci.e2eJobPresent || obs.ci.parallelOrSharded) return undefined;
  if (obs.totalSpecFilesFound < 20) return undefined;
  return {
    id: "SPD-002",
    axis: "feedback_speed",
    severity: "medium",
    title: "E2E job is not sharded in CI",
    observation: `${obs.totalSpecFilesFound} spec files run in a single CI job (no parallel/matrix/--shard).`,
    impact: "A single long job is the pipeline's critical path; it delays every merge and encourages blanket retries.",
    recommendation: "Shard the E2E job (GitLab `parallel:` + `--shard`, or a GitHub matrix) and merge reports afterwards.",
    effort: "S",
    quickWin: true,
    basis: "observed",
    evidence: obs.ci.files.map((f) => ({ file: f })),
    occurrences: 1,
  };
};

const noCiCache: Rule = (obs) => {
  if (!obs.ci.e2eJobPresent || obs.ci.dependencyCache) return undefined;
  return {
    id: "SPD-003",
    axis: "feedback_speed",
    severity: "low",
    title: "No dependency/browser cache in CI",
    observation: "The CI definition installs dependencies without a cache directive.",
    impact: "Minutes of install time are paid on every pipeline before a single test runs.",
    recommendation: "Cache the package-manager store and the browser binaries (or use the official Playwright/Cypress image).",
    effort: "S",
    quickWin: true,
    basis: "observed",
    evidence: obs.ci.files.map((f) => ({ file: f })),
    occurrences: 1,
  };
};

// --- Coverage and risk -------------------------------------------------------

const noPrioritisation: Rule = (obs) => {
  if (obs.specs.length === 0) return undefined;
  const tagged = obs.specs.filter((s) => s.priorityTags.length > 0).length;
  const share = pct(tagged, obs.specs.length);
  if (share >= 50) return undefined;
  return {
    id: "COV-001",
    axis: "coverage_and_risk",
    severity: share === 0 ? "high" : "medium",
    title: "Tests are not prioritised by risk",
    observation: `${tagged} of ${obs.specs.length} spec files (${share}%) carry a priority or scope tag (@p0, @smoke, @critical…).`,
    impact:
      "Without priorities the suite is all-or-nothing: the team cannot run a fast critical subset on every merge request and a full run nightly, and cannot say what a red pipeline actually blocks.",
    recommendation:
      "Classify journeys by business risk (P0 = revenue/compliance/auth, P1, P2), tag the tests, and wire the CI gate to the P0 subset. This is the foundation of a risk-based strategy.",
    effort: "M",
    quickWin: false,
    basis: "observed",
    evidence: [],
    occurrences: obs.specs.length - tagged,
  };
};

const skippedTests: Rule = (obs) => {
  const n = sumOcc(obs.specs, (s) => s.skippedTests);
  if (n === 0) return undefined;
  return {
    id: "COV-002",
    axis: "coverage_and_risk",
    severity: n >= 10 ? "high" : n >= 3 ? "medium" : "low",
    title: "Skipped or fixme tests accumulating",
    observation: `${n} skipped/fixme test(s) across ${filesWith(obs.specs, (s) => s.skippedTests)} file(s).`,
    impact: "Each skip is coverage the team believes it has but does not. Skips without an owner and a ticket are never un-skipped.",
    recommendation: "Triage every skip: delete, fix, or link it to a ticket with an expiry. Add a CI check that fails on skips without a reason.",
    effort: "S",
    quickWin: true,
    basis: "observed",
    evidence: evidenceFrom(obs.specs, (s) => s.skippedTests),
    occurrences: n,
  };
};

const focusedTests: Rule = (obs) => {
  const n = sumOcc(obs.specs, (s) => s.focusedTests);
  if (n === 0) return undefined;
  return {
    id: "COV-003",
    axis: "coverage_and_risk",
    severity: "critical",
    title: "A focused test (.only) is committed",
    observation: `${n} .only/fit/fdescribe marker(s) in ${filesWith(obs.specs, (s) => s.focusedTests)} file(s).`,
    impact: "On CI, `.only` silently disables every other test in the file (or the run). The pipeline is green and coverage is gone.",
    recommendation: "Remove the markers now; add `forbidOnly: !!process.env.CI` (Playwright) or an ESLint rule so it cannot recur.",
    effort: "S",
    quickWin: true,
    basis: "observed",
    evidence: evidenceFrom(obs.specs, (s) => s.focusedTests),
    occurrences: n,
  };
};

const noAssertions: Rule = (obs) => {
  const n = obs.specs.reduce((a, s) => a + s.testsWithoutAssertion, 0);
  if (n === 0) return undefined;
  const files = obs.specs.filter((s) => s.testsWithoutAssertion > 0);
  // Heuristic by construction: the scanner sees inline expect/should/assert and
  // calls to helpers *named* like assertions. A helper that asserts under
  // another name is invisible, so this is "no visible assertion", never
  // "missing coverage", and its severity stays below the deterministic rules.
  return {
    id: "COV-004",
    axis: "coverage_and_risk",
    severity: n >= 10 ? "medium" : "low",
    title: "Tests without a visible assertion (heuristic)",
    observation: `${n} test(s) in ${files.length} file(s) contain no inline expect/should/assert and no call to an assertion-named helper. Heuristic: open each one before reporting it.`,
    impact: "A test that only navigates and clicks proves nothing about the product; it passes as long as nothing throws.",
    recommendation: "Confirm by reading the test; if it truly asserts nothing, add an assertion on the user-visible outcome or delete it. If it asserts inside a helper, name the helper so intent is visible (verify…, assert…).",
    effort: "S",
    quickWin: true,
    basis: "observed",
    evidence: files.slice(0, MAX_EVIDENCE).map((s) => ({ file: s.path, snippet: `${s.testsWithoutAssertion} test(s) without a visible assertion` })),
    occurrences: n,
  };
};

const noCiGate: Rule = (obs) => {
  if (obs.ci.provider === "none") {
    return {
      id: "COV-005",
      axis: "coverage_and_risk",
      severity: "high",
      title: "No CI definition found at the audited root",
      observation: "No .gitlab-ci.yml or GitHub workflow at or below the audited root. The pipeline may be defined in a parent repository or another CI system.",
      impact: "If the suite really has no CI gate, tests that only run on a laptop are documentation, not a quality gate.",
      recommendation: "Confirm where (and whether) the suite runs in CI. If nowhere: add a pipeline that runs the critical subset on every merge request and the full suite nightly.",
      effort: "M",
      quickWin: false,
      basis: "not_observed",
      evidence: [],
      occurrences: 1,
    };
  }
  if (!obs.ci.e2eJobPresent) {
    return {
      id: "COV-005",
      axis: "coverage_and_risk",
      severity: "high",
      title: "No CI job runs the E2E suite",
      observation: `CI files found (${obs.ci.files.join(", ")}) but no job runs a Playwright/Cypress command (comments and image names are ignored).`,
      impact: "The suite does not protect releases: regressions are found by users, not by the pipeline.",
      recommendation: "Add an E2E job on merge requests (critical subset) and a scheduled full run.",
      effort: "M",
      quickWin: false,
      basis: "observed",
      evidence: obs.ci.files.map((f) => ({ file: f })),
      occurrences: 1,
    };
  }
  if (!obs.ci.scheduledRun) {
    return {
      id: "COV-006",
      axis: "coverage_and_risk",
      severity: "low",
      title: "No scheduled (nightly) full run",
      observation: "The CI definition has no schedule/nightly trigger.",
      impact: "Environment drift and slow flake go unnoticed between merges; the full suite is only run under release pressure.",
      recommendation: "Schedule a nightly full run against staging and review its trend weekly.",
      effort: "S",
      quickWin: true,
      basis: "observed",
      evidence: obs.ci.files.map((f) => ({ file: f })),
      occurrences: 1,
    };
  }
  return undefined;
};

// --- Observability -----------------------------------------------------------

const noMachineReport: Rule = (obs) => {
  if (!obs.runnerConfig.configFile) return undefined; // not observed — see CFG-001
  const r = obs.runnerConfig.reporters;
  const machine = r.some((x) => /json|junit|allure|mochawesome|blob/.test(x));
  if (machine) return undefined;
  return {
    id: "OBS-001",
    axis: "observability",
    severity: "high",
    title: "No machine-readable test report",
    observation: `Reporters configured: ${r.length ? r.join(", ") : "none/default"}. No JSON, JUnit or Allure output.`,
    impact:
      "Without a structured report there is no flakiness trend, no CI test tab, and nothing for AI-assisted triage to reason over. Every failure is investigated from a console log.",
    recommendation: "Add `json` and `junit` reporters (keep `html` for humans), publish them as CI artifacts, and feed JUnit to the CI test tab.",
    effort: "S",
    quickWin: true,
    basis: "observed",
    evidence: obs.runnerConfig.configFile ? [{ file: obs.runnerConfig.configFile }] : [],
    occurrences: 1,
  };
};

const noFailureArtifacts: Rule = (obs) => {
  if (!obs.runnerConfig.configFile) return undefined; // not observed — see CFG-001
  const { traceOnFailure, screenshotOnFailure, videoOnFailure } = obs.runnerConfig;
  const pw = obs.framework !== "cypress";
  const missing: string[] = [];
  if (pw && traceOnFailure === false) missing.push("trace");
  if (screenshotOnFailure === false) missing.push("screenshot");
  if (pw && traceOnFailure === undefined && screenshotOnFailure === undefined && videoOnFailure === undefined) missing.push("trace/screenshot/video (nothing configured)");
  if (missing.length === 0) return undefined;
  return {
    id: "OBS-002",
    axis: "observability",
    severity: "medium",
    title: "Failure evidence not captured",
    observation: `Not configured on failure: ${missing.join(", ")}.`,
    impact: "A failing CI test without a trace or screenshot costs a local reproduction attempt every time — often 30–60 minutes per failure.",
    recommendation: pw
      ? "Set `trace: 'retain-on-failure'` (or 'on-first-retry') and `screenshot: 'only-on-failure'`; keep video off unless needed."
      : "Keep screenshotOnRunFailure on; enable video only on CI and only for failing specs if the plan allows.",
    effort: "S",
    quickWin: true,
    basis: "observed",
    evidence: obs.runnerConfig.configFile ? [{ file: obs.runnerConfig.configFile }] : [],
    occurrences: 1,
  };
};

const artifactsNotPublished: Rule = (obs) => {
  if (!obs.ci.e2eJobPresent || obs.ci.artifactsPublished) return undefined;
  return {
    id: "OBS-003",
    axis: "observability",
    severity: "medium",
    title: "CI does not publish test artifacts",
    observation: "The E2E job has no artifacts/upload directive for reports, traces or screenshots.",
    impact: "Evidence is produced on the runner and thrown away; investigating a red pipeline means re-running it.",
    recommendation: "Publish the report folder and traces as job artifacts (with `when: always`) and wire the JUnit file to the test tab.",
    effort: "S",
    quickWin: true,
    basis: "observed",
    evidence: obs.ci.files.map((f) => ({ file: f })),
    occurrences: 1,
  };
};

// --- Governance --------------------------------------------------------------

const secrets: Rule = (obs) => {
  const n = sumOcc(obs.specs, (s) => s.hardcodedSecrets);
  if (n === 0) return undefined;
  return {
    id: "GOV-001",
    axis: "governance",
    severity: "critical",
    title: "Credentials hard-coded in test code",
    observation: `${n} literal password/token assignment(s) in ${filesWith(obs.specs, (s) => s.hardcodedSecrets)} file(s).`,
    impact: "Secrets in a repository are a security incident waiting to happen and tie the suite to one account, which also breaks parallel runs.",
    recommendation: "Move credentials to CI variables / a secret store, load them via env, and rotate the exposed ones.",
    effort: "S",
    quickWin: true,
    basis: "observed",
    evidence: evidenceFrom(obs.specs, (s) => s.hardcodedSecrets),
    occurrences: n,
  };
};

const noDocs: Rule = (obs) => {
  if (obs.repo.testingReadme) return undefined;
  return {
    id: "GOV-002",
    axis: "governance",
    severity: "medium",
    title: "No written testing standard or runbook",
    observation: "No README/CONTRIBUTING/TESTING section about how tests are written and run.",
    impact: "Standards live in people's heads; onboarding and consistency depend on who reviews the merge request.",
    recommendation: "Write a one-page testing guide: how to run locally, locator and naming conventions, how to tag priorities, what to do with a flaky test.",
    effort: "S",
    quickWin: true,
    basis: "not_observed",
    evidence: [],
    occurrences: 1,
  };
};

const noE2eScript: Rule = (obs) => {
  if (obs.repo.e2eScript) return undefined;
  return {
    id: "GOV-003",
    axis: "governance",
    severity: "low",
    title: "No dedicated E2E script in package.json",
    observation: "No `test:e2e`/`playwright test`/`cypress run` script found.",
    impact: "Running the suite depends on remembering the right command and flags; CI and local runs drift apart.",
    recommendation: "Add `test:e2e` (and `test:e2e:critical`) scripts used identically by developers and CI.",
    effort: "S",
    quickWin: true,
    basis: "not_observed",
    evidence: [],
    occurrences: 1,
  };
};

const noLockfile: Rule = (obs) => {
  if (obs.repo.lockfile) return undefined;
  return {
    id: "GOV-004",
    axis: "governance",
    severity: "medium",
    title: "No lockfile",
    observation: "No pnpm-lock.yaml / package-lock.json / yarn.lock at the root.",
    impact: "Browser and framework versions float between runs; 'works on my machine' becomes 'worked on yesterday's CI'.",
    recommendation: "Commit the lockfile and pin the Playwright/Cypress version to the CI image.",
    effort: "S",
    quickWin: true,
    basis: "not_observed",
    evidence: [],
    occurrences: 1,
  };
};

const noRunnerConfig: Rule = (obs) => {
  if (obs.runnerConfig.configFile || obs.specs.length === 0) return undefined;
  return {
    id: "CFG-001",
    axis: "observability",
    severity: "medium",
    title: "Runner configuration not found at the audited root",
    observation: `${obs.specs.length} spec file(s) found but no playwright.config/cypress.config at or below the root.`,
    impact: "Retries, reporters, traces and parallelism could not be judged. They may be configured elsewhere (a parent directory, a shared package) or not at all.",
    recommendation: "Point the audit at the directory that holds the test config, or confirm with the team where the runner is configured.",
    effort: "S",
    quickWin: false,
    basis: "not_observed",
    evidence: [],
    occurrences: 1,
  };
};

const noSpecs: Rule = (obs) => {
  if (obs.specs.length > 0) return undefined;
  return {
    id: "COV-000",
    axis: "coverage_and_risk",
    severity: "critical",
    title: "No test specs found",
    observation: `No *.spec/*.test/*.cy files found under the audited root (framework detected: ${obs.framework}).`,
    impact: "There is nothing to audit; either the suite lives elsewhere or it does not exist yet.",
    recommendation: "Point the audit at the directory holding the test config, or start with a critical-journey prototype.",
    effort: "S",
    quickWin: false,
    basis: "observed",
    evidence: [],
    occurrences: 1,
  };
};

export const RULES: Rule[] = [
  noSpecs,
  noRunnerConfig,
  focusedTests,
  secrets,
  noCiGate,
  hardWaits,
  retriesMaskFlake,
  uiLoginEverywhere,
  forcedActions,
  conditionalFlow,
  fragileSelectors,
  noSemanticLocators,
  noAbstraction,
  hardcodedUrls,
  largeSpecs,
  noTypeSafety,
  noLint,
  noParallelism,
  ciNotSharded,
  noCiCache,
  noPrioritisation,
  skippedTests,
  noAssertions,
  noMachineReport,
  noFailureArtifacts,
  artifactsNotPublished,
  noDocs,
  noE2eScript,
  noLockfile,
];

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function collectFindings(obs: TestSuiteObservation): Finding[] {
  const out: Finding[] = [];
  for (const rule of RULES) {
    const f = rule(obs);
    if (f) out.push(f);
  }
  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.occurrences - a.occurrences);
}

// --- Scoring -----------------------------------------------------------------

export const LEVEL_LABELS = ["absent", "ad hoc", "defined", "managed", "optimized"] as const;

const AXES: Axis[] = ["reliability", "maintainability", "feedback_speed", "coverage_and_risk", "observability", "governance"];

/**
 * Score an axis from its findings. Start at 4 (optimized) and deduct per
 * finding by severity; the floor is 0. A critical finding caps the axis at 1 —
 * a committed `.only` or a missing CI gate is not "managed" whatever else is
 * true. Axes with no findings but no positive signal either sit at 3, not 4:
 * a static audit cannot prove "optimized".
 */
export function scoreAxes(obs: TestSuiteObservation, findings: Finding[]): AxisScore[] {
  const deduction: Record<Severity, number> = { critical: 3, high: 1.5, medium: 1, low: 0.5 };
  return AXES.map((axis) => {
    const mine = findings.filter((f) => f.axis === axis);
    // A smell seen in the files counts fully; something merely not found at the
    // audited root counts half — it may exist elsewhere, and the completeness
    // block tells the reader to check.
    let score = 4 - mine.reduce((a, f) => a + deduction[f.severity] * (f.basis === "observed" ? 1 : 0.5), 0);
    if (mine.some((f) => f.severity === "critical" && f.basis === "observed")) score = Math.min(score, 1);
    // "Optimized" needs run data and a trend; a static audit awards it only when
    // there is nothing to report *and* the positive signals are all present.
    if (mine.length > 0 || !positiveSignal(obs, axis)) score = Math.min(score, 3);
    const level = Math.max(0, Math.min(4, Math.round(score)));
    const rationale =
      mine.length === 0
        ? positiveSignal(obs, axis)
          ? "No findings and positive signals present."
          : "No findings, but a static audit cannot confirm optimisation; verify with run data."
        : `${mine.length} finding(s): ${mine
            .slice(0, 3)
            .map((f) => f.id)
            .join(", ")}${mine.length > 3 ? ", …" : "."}`;
    return { axis, level, label: LEVEL_LABELS[level]!, rationale };
  });
}

function positiveSignal(obs: TestSuiteObservation, axis: Axis): boolean {
  switch (axis) {
    case "reliability":
      return obs.runnerConfig.storageStateOrSession && (obs.runnerConfig.retries ?? 0) <= 1;
    case "maintainability":
      return obs.specs.length > 0 && obs.specs.every((s) => s.usesSemanticLocators) && obs.repo.lintConfigured;
    case "feedback_speed":
      return Boolean(obs.ci.parallelOrSharded && obs.ci.dependencyCache);
    case "coverage_and_risk":
      return obs.specs.length > 0 && obs.specs.every((s) => s.priorityTags.length > 0) && Boolean(obs.ci.scheduledRun);
    case "observability":
      return Boolean(obs.ci.junitReportWired && obs.ci.artifactsPublished);
    case "governance":
      return obs.repo.testingReadme && obs.repo.lockfile && obs.repo.e2eScript;
  }
}

export function overallLevel(axes: AxisScore[]): number {
  if (axes.length === 0) return 0;
  // Weakest-link weighted: average, pulled down toward the minimum. A suite is
  // only as trustworthy as its least mature axis.
  const avg = axes.reduce((a, x) => a + x.level, 0) / axes.length;
  const min = Math.min(...axes.map((x) => x.level));
  return Math.max(0, Math.min(4, Math.round((avg * 2 + min) / 3)));
}

// --- Hotspots ----------------------------------------------------------------

/** The spec files a fix PR should start with, by smell density. */
export function rankHotspots(specs: SpecObservation[], limit = 10): Hotspot[] {
  const weights: Array<[keyof SpecObservation, number, string]> = [
    ["focusedTests", 10, "focused test"],
    ["hardcodedSecrets", 8, "hard-coded secret"],
    ["hardWaits", 3, "hard wait"],
    ["forcedActions", 2, "forced action"],
    ["fragileSelectors", 2, "brittle selector"],
    ["conditionalFlow", 1.5, "conditional flow"],
    ["uiLoginSteps", 1.5, "UI login"],
    ["skippedTests", 1, "skipped test"],
    ["hardcodedUrls", 1, "hard-coded URL"],
  ];
  const ranked: Hotspot[] = [];
  for (const s of specs) {
    let score = 0;
    const reasons: string[] = [];
    for (const [key, w, label] of weights) {
      const list = s[key] as Occurrence[];
      if (list.length) {
        score += list.length * w;
        reasons.push(`${list.length} ${label}${list.length > 1 ? "s" : ""}`);
      }
    }
    if (s.testsWithoutAssertion) {
      score += s.testsWithoutAssertion * 2;
      reasons.push(`${s.testsWithoutAssertion} test(s) without visible assertion`);
    }
    if (score > 0) ranked.push({ path: s.path, score: Math.round(score * 10) / 10, reasons });
  }
  return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
}

// --- Planning ----------------------------------------------------------------

/**
 * Turn findings into the engagement's three phases. Quick wins go to the
 * prototype (the "fixed in a PR" deliverable); structural work goes to adopt;
 * what a static audit cannot settle goes to diagnose.
 */
export function planActions(obs: TestSuiteObservation, findings: Finding[]): PlannedAction[] {
  const plan: PlannedAction[] = [];

  plan.push({
    phase: "diagnose",
    priority: "now",
    action: "Measure flakiness from real run data: last 20–30 CI runs, retried tests, pass rate per spec, pipeline duration.",
    rationale: "A static audit sees smells, not outcomes. Run data turns findings into a prioritised list with numbers the team already trusts.",
    findingIds: findings.filter((f) => f.axis === "reliability" || f.axis === "observability").map((f) => f.id),
    effort: "S",
  });
  plan.push({
    phase: "diagnose",
    priority: "now",
    action: "Interview the team on release friction: what blocks a merge, how a red pipeline is handled, who owns a flaky test.",
    rationale: "Process findings (ownership, skip policy, review) are invisible to a scanner and usually explain the technical ones.",
    findingIds: findings.filter((f) => f.axis === "governance").map((f) => f.id),
    effort: "S",
  });

  const critical = findings.filter((f) => f.severity === "critical");
  if (critical.length) {
    plan.push({
      phase: "prototype",
      priority: "now",
      action: `Fix the ${critical.length} critical finding(s) first: ${critical.map((f) => f.title.toLowerCase()).join("; ")}.`,
      rationale: "They either hide coverage (.only, no CI) or expose secrets; nothing else in the plan is credible until they are gone.",
      findingIds: critical.map((f) => f.id),
      effort: "S",
    });
  }

  const quick = findings.filter((f) => f.quickWin && f.severity !== "critical");
  if (quick.length) {
    plan.push({
      phase: "prototype",
      priority: "now",
      action: `Open one pull request that applies the quick wins (${quick.map((f) => f.id).join(", ")}) to the top hotspot spec files.`,
      rationale: "A visible, reviewable improvement in days builds the trust needed for the structural work — and demonstrates the standard by example.",
      findingIds: quick.map((f) => f.id),
      effort: quick.length > 6 ? "M" : "S",
    });
  }

  const structural = findings.filter((f) => !f.quickWin && f.severity !== "critical");
  if (structural.length) {
    plan.push({
      phase: "adopt",
      priority: "next",
      action: `Run the structural improvements as team workstreams: ${structural.map((f) => f.id).join(", ")}.`,
      rationale: "Prioritisation by risk, an abstraction layer and parallel-safe tests are practice changes; they stick only when the team owns them.",
      findingIds: structural.map((f) => f.id),
      effort: "L",
    });
  }

  plan.push({
    phase: "adopt",
    priority: "next",
    action: "Write (or update) the testing standard and enforce it: lint rules, a merge-request checklist, and a flaky-test policy with quarantine + ticket + expiry.",
    rationale: "Standards that are written, linted and reviewed survive the consultant leaving.",
    findingIds: findings.filter((f) => ["GOV-002", "MNT-007", "COV-002", "REL-004"].includes(f.id)).map((f) => f.id),
    effort: "M",
  });
  plan.push({
    phase: "adopt",
    priority: "later",
    action: "Set up a weekly quality review: flakiness trend, pipeline duration, skipped-test count, top failing specs — and use the triage capability on every retried test.",
    rationale: "Keeps the gains measurable; this is also the point where AI-assisted triage becomes useful, because the evidence now exists.",
    findingIds: findings.filter((f) => f.axis === "observability").map((f) => f.id),
    effort: "S",
  });

  return plan;
}

// --- Caveats -----------------------------------------------------------------

export function caveats(obs: TestSuiteObservation): string[] {
  const out = [
    "Static analysis: it sees patterns in code, not run outcomes. Confirm reliability findings with CI history before quoting numbers to the team.",
    "Regex-based detectors can miss unconventional code and flag legitimate exceptions; every evidence line should be opened before it goes in a report.",
  ];
  if (obs.framework === "unknown") out.push("No Playwright/Cypress config was recognised; the audit may be pointed at the wrong directory.");
  if (obs.totalSpecFilesFound > obs.specs.length) out.push(`${obs.totalSpecFilesFound - obs.specs.length} spec files were counted but not analysed (cap).`);
  if (obs.ci.provider === "other") out.push("CI provider not recognised as GitLab/GitHub; CI findings are approximate.");
  return out.concat(obs.scanNotes);
}
