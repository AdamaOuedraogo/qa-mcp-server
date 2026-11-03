import { z } from "zod";

/**
 * Test Suite Audit — data contract.
 *
 * Same architectural rule as every capability in this project:
 *
 *   Raw Data  ->  QA Expertise  ->  Structured Judgment
 *
 * The *observation* is what a scanner (or an agent reading a repository) can
 * see: files, counts, config values, CI jobs. It carries no opinion. The
 * *judgment* is what a senior QA consultant produces on the first days of an
 * engagement: a maturity assessment, findings backed by file:line evidence,
 * and a prioritized action plan. Returning the counts back would be a
 * connector; this capability returns the audit.
 */

// --- Observation -------------------------------------------------------------

export const FrameworkSchema = z.enum(["playwright", "cypress", "mixed", "unknown"]);
export type Framework = z.infer<typeof FrameworkSchema>;

/** A single occurrence of a pattern in a spec file. Kept small: it is evidence. */
export const OccurrenceSchema = z.object({
  line: z.number().int().positive(),
  snippet: z.string().max(200).describe("The trimmed source line, truncated."),
});
export type Occurrence = z.infer<typeof OccurrenceSchema>;

/**
 * What the scanner saw in one spec file. Every counter is a *smell signal*,
 * named after what a reviewer would flag, not after the regex that found it.
 * Occurrences are capped per file so the observation stays bounded.
 */
export const SpecObservationSchema = z.object({
  path: z.string().describe("Path relative to the audited project root."),
  lines: z.number().int().nonnegative(),
  tests: z.number().int().nonnegative().describe("Number of test()/it() blocks."),
  hardWaits: z.array(OccurrenceSchema).describe("Fixed sleeps: waitForTimeout, cy.wait(ms), setTimeout…"),
  focusedTests: z.array(OccurrenceSchema).describe(".only — a focused test committed to the suite."),
  skippedTests: z.array(OccurrenceSchema).describe(".skip / xit / xdescribe / test.fixme."),
  forcedActions: z.array(OccurrenceSchema).describe("{ force: true } — bypassing actionability checks."),
  fragileSelectors: z.array(OccurrenceSchema).describe("XPath, deep CSS chains, nth-child, class/tag soup."),
  conditionalFlow: z.array(OccurrenceSchema).describe("if/else or try/catch inside a test body."),
  hardcodedSecrets: z.array(OccurrenceSchema).describe("Literal passwords/tokens in test code."),
  hardcodedUrls: z.array(OccurrenceSchema).describe("Absolute environment URLs instead of baseURL."),
  uiLoginSteps: z.array(OccurrenceSchema).describe("Logging in through the UI inside a spec (vs. storageState/session)."),
  testsWithoutAssertion: z.number().int().nonnegative(),
  usesSemanticLocators: z.boolean().describe("getByRole/getByLabel/getByTestId/cy.findByRole seen."),
  usesPageObjectOrFixture: z.boolean().describe("Imports a page object, fixture, or custom command module."),
  priorityTags: z.array(z.string()).describe("Tags like @p0, @smoke, @critical found in titles or grep."),
});
export type SpecObservation = z.infer<typeof SpecObservationSchema>;

/** Values read from playwright.config / cypress.config. Unknown means not found. */
export const RunnerConfigObservationSchema = z.object({
  configFile: z.string().optional(),
  retries: z.number().int().nonnegative().optional(),
  workers: z.union([z.number().int().positive(), z.string()]).optional(),
  fullyParallel: z.boolean().optional(),
  reporters: z.array(z.string()).describe("Reporter names seen, e.g. html, json, junit, list."),
  traceOnFailure: z.boolean().optional().describe("Playwright trace: 'on-first-retry'/'retain-on-failure'/'on'."),
  screenshotOnFailure: z.boolean().optional(),
  videoOnFailure: z.boolean().optional(),
  baseUrlConfigured: z.boolean(),
  testIdAttributeConfigured: z.boolean().optional(),
  storageStateOrSession: z.boolean().describe("storageState / globalSetup / cy.session usage in config or tests."),
  projects: z.number().int().nonnegative().optional().describe("Playwright projects (browsers/devices) declared."),
  globalTimeoutMs: z.number().int().positive().optional(),
});
export type RunnerConfigObservation = z.infer<typeof RunnerConfigObservationSchema>;

export const CiObservationSchema = z.object({
  provider: z.enum(["gitlab", "github", "other", "none"]),
  files: z.array(z.string()),
  e2eJobPresent: z.boolean().describe("A job/step that runs Playwright or Cypress."),
  runsOnMergeRequest: z.boolean().optional(),
  scheduledRun: z.boolean().optional().describe("A nightly/scheduled pipeline exists."),
  artifactsPublished: z.boolean().optional().describe("Reports/traces/videos kept as CI artifacts."),
  junitReportWired: z.boolean().optional().describe("JUnit report fed to the CI's test tab."),
  parallelOrSharded: z.boolean().optional(),
  blanketJobRetry: z.boolean().optional().describe("CI-level retry of the whole job (masks flake)."),
  dependencyCache: z.boolean().optional(),
});
export type CiObservation = z.infer<typeof CiObservationSchema>;

export const RepoObservationSchema = z.object({
  typescript: z.boolean(),
  tsStrict: z.boolean().optional(),
  lintConfigured: z.boolean(),
  formatterConfigured: z.boolean(),
  lockfile: z.boolean(),
  e2eScript: z.boolean().describe("A package.json script dedicated to E2E tests."),
  testingReadme: z.boolean().describe("A README/CONTRIBUTING section or docs file about tests."),
  pageObjectsDir: z.boolean(),
  fixturesOrSeedDir: z.boolean(),
  frameworkVersion: z.string().optional(),
  packageJsonFound: z.boolean().optional().describe("Whether a package.json was found and parsed at the root."),
});
export type RepoObservation = z.infer<typeof RepoObservationSchema>;

/** The whole observation the audit reasons over. */
export const TestSuiteObservationSchema = z.object({
  projectName: z.string().optional(),
  framework: FrameworkSchema,
  specs: z.array(SpecObservationSchema),
  totalSpecFilesFound: z.number().int().nonnegative().describe("May exceed specs.length if capped."),
  runnerConfig: RunnerConfigObservationSchema,
  ci: CiObservationSchema,
  repo: RepoObservationSchema,
  scanNotes: z.array(z.string()).describe("Scanner caveats: caps hit, files skipped, parse limits."),
});
export type TestSuiteObservation = z.infer<typeof TestSuiteObservationSchema>;

// --- Judgment -----------------------------------------------------------------

/**
 * The six axes a consultant scores on day one. They map onto the three service
 * lines of a quality-engineering practice: reliability + maintainability belong
 * to *QA automation*; speed, coverage and governance to *quality engineering*;
 * observability is the bridge to *AI-assisted analysis* (no evidence, no AI).
 */
export const AxisSchema = z.enum([
  "reliability",
  "maintainability",
  "feedback_speed",
  "coverage_and_risk",
  "observability",
  "governance",
]);
export type Axis = z.infer<typeof AxisSchema>;

/** 0 = absent, 1 = ad hoc, 2 = defined, 3 = managed, 4 = optimized. */
export const MaturityLevelSchema = z.number().int().min(0).max(4);

export const AxisScoreSchema = z.object({
  axis: AxisSchema,
  level: MaturityLevelSchema,
  label: z.string().describe("Human label for the level, e.g. 'defined'."),
  rationale: z.string().describe("One sentence citing what drove the score."),
});
export type AxisScore = z.infer<typeof AxisScoreSchema>;

export const SeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const EffortSchema = z.enum(["S", "M", "L"]).describe("S: < 1 day, M: 1–3 days, L: > 3 days.");
export type Effort = z.infer<typeof EffortSchema>;

export const EvidenceRefSchema = z.object({
  file: z.string(),
  line: z.number().int().positive().optional(),
  snippet: z.string().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

/** One thing the audit would put in the report, with the proof next to it. */
export const FindingSchema = z.object({
  id: z.string().describe("Stable rule id, e.g. REL-001."),
  axis: AxisSchema,
  severity: SeveritySchema,
  title: z.string(),
  observation: z.string().describe("What was seen, with numbers."),
  impact: z.string().describe("Why a team should care — in release/feedback terms."),
  recommendation: z.string().describe("The concrete change a senior QA would make."),
  effort: EffortSchema,
  quickWin: z.boolean().describe("Fixable inside a 2-day audit, typically in one pull request."),
  basis: z
    .enum(["observed", "not_observed"])
    .describe(
      "observed: the smell was seen in the files. not_observed: something expected was not found at the " +
        "audited root (config, CI, lockfile…) — it may live elsewhere; verify before reporting as absent.",
    ),
  evidence: z.array(EvidenceRefSchema).describe("file:line proof, capped."),
  occurrences: z.number().int().nonnegative().describe("Total occurrences across the suite."),
});
export type Finding = z.infer<typeof FindingSchema>;

/**
 * A spec file worth fixing first: the audit's "most expensive tests" list.
 * Ranked by smell density, because that is where a fix PR pays off fastest.
 */
export const HotspotSchema = z.object({
  path: z.string(),
  score: z.number().nonnegative(),
  reasons: z.array(z.string()),
});
export type Hotspot = z.infer<typeof HotspotSchema>;

/** The engagement model the plan is written for: Diagnose -> Prototype -> Adopt. */
export const PhaseSchema = z.enum(["diagnose", "prototype", "adopt"]);
export type Phase = z.infer<typeof PhaseSchema>;

export const PlannedActionSchema = z.object({
  phase: PhaseSchema,
  priority: z.enum(["now", "next", "later"]),
  action: z.string(),
  rationale: z.string(),
  findingIds: z.array(z.string()),
  effort: EffortSchema,
});
export type PlannedAction = z.infer<typeof PlannedActionSchema>;

/** The structured judgment — the product of this capability. */
export const TestSuiteAuditJudgmentSchema = z.object({
  headline: z.string().describe("One line a CTO can read."),
  summary: z.string().describe("A short executive paragraph."),
  overallLevel: MaturityLevelSchema,
  overallLabel: z.string(),
  axes: z.array(AxisScoreSchema),
  findings: z.array(FindingSchema).describe("Sorted by severity, then occurrences."),
  hotspots: z.array(HotspotSchema).describe("Spec files to fix first (max 10)."),
  actionPlan: z.array(PlannedActionSchema).describe("Diagnose / Prototype / Adopt."),
  quickWinCount: z.number().int().nonnegative(),
  metrics: z.object({
    specFiles: z.number().int().nonnegative(),
    tests: z.number().int().nonnegative(),
    hardWaits: z.number().int().nonnegative(),
    skippedTests: z.number().int().nonnegative(),
    focusedTests: z.number().int().nonnegative(),
    fragileSelectors: z.number().int().nonnegative(),
    specsWithSemanticLocators: z.number().int().nonnegative(),
    specsWithPageObjects: z.number().int().nonnegative(),
    specsWithPriorityTags: z.number().int().nonnegative(),
  }),
  completeness: z.object({
    score: z.number().min(0).max(1).describe("How much of the expected input the scan actually saw (1 = everything)."),
    specsAnalysed: z.number().int().nonnegative(),
    specsFound: z.number().int().nonnegative(),
    runnerConfigFound: z.boolean(),
    ciDefinitionFound: z.boolean(),
    packageJsonFound: z.boolean(),
    notes: z.array(z.string()).describe("What was not observed and therefore not judged."),
  }),
  caveats: z.array(z.string()).describe("What a static audit cannot see; what to verify with the team."),
});
export type TestSuiteAuditJudgment = z.infer<typeof TestSuiteAuditJudgmentSchema>;
