import { z } from "zod";

/**
 * Flaky Test Triage — data contract.
 *
 * This file encodes Architectural Rule #1 of the project: a capability contract
 * carries *judgment*, not data. The input is a normalized *observation* of a
 * failing test (assembled from any reporter — Playwright, Mochawesome, JUnit —
 * via the adapters). The output is a *structured QA judgment*, never a raw count.
 *
 *   Raw Data  ->  QA Expertise  ->  Structured Judgment
 *
 * If a module returns the input's numbers back, it is a connector. A capability
 * of this project returns an assessment with confidence, evidence, and actions.
 */

/** The status of a single attempt of a test within one CI run. */
export const AttemptStatusSchema = z.enum([
  "passed",
  "failed",
  "timedOut",
  "skipped",
]);
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;

/**
 * One attempt of a test. Retries produce multiple attempts of the *same* test
 * at the *same* commit — the single most decisive signal for flakiness.
 */
export const TestAttemptSchema = z.object({
  attempt: z.number().int().nonnegative().describe("0-based attempt index (0 = first try)."),
  status: AttemptStatusSchema,
  durationMs: z.number().nonnegative().optional().describe("Wall-clock duration of the attempt."),
  errorType: z
    .string()
    .optional()
    .describe("Error class if known, e.g. TimeoutError, AssertionError, Error."),
  errorMessage: z
    .string()
    .optional()
    .describe("First line / message of the failure, if any."),
});
export type TestAttempt = z.infer<typeof TestAttemptSchema>;

/**
 * Cross-run history for this test. Optional but powerful: an intermittent pass
 * rate over recent runs is strong evidence of flakiness independent of retries.
 */
export const TestHistorySchema = z.object({
  runs: z.number().int().positive().describe("Number of recent runs considered."),
  failures: z.number().int().nonnegative().describe("How many of those runs failed."),
  distinctErrorMessages: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Number of distinct failure messages seen. >1 suggests non-determinism."),
});
export type TestHistory = z.infer<typeof TestHistorySchema>;

/**
 * Artifacts that point at deeper evidence. These are references, not parsed
 * content — e.g. a Cypress Test Replay link. The resolution phase (not yet
 * built) will mine them; for now they are carried through so we don't lose the
 * door to the evidence.
 */
export const ArtifactsSchema = z.object({
  testReplayUrl: z.string().optional().describe("Cypress Test Replay link for this attempt."),
  screenshotUrl: z.string().optional().describe("Failure screenshot."),
  videoUrl: z.string().optional().describe("Run video."),
});
export type Artifacts = z.infer<typeof ArtifactsSchema>;

/**
 * Signals a vendor (e.g. Cypress Cloud) already computed. Consumed as *priors*
 * only — they nudge confidence, never override the local verdict. A vendor
 * "flaky" flag must never flip a deterministic-regression finding.
 */
export const VendorSignalsSchema = z.object({
  isFlakyVendorVerdict: z
    .boolean()
    .optional()
    .describe("Whether the vendor's flaky detection flagged this test."),
  flakinessRate: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Vendor-computed flakiness rate over recent runs (0..1)."),
  severity: z
    .enum(["high", "medium", "low"])
    .optional()
    .describe("Vendor severity classification of the flakiness."),
});
export type VendorSignals = z.infer<typeof VendorSignalsSchema>;

/**
 * The same test's outcome on the baseline (e.g. the target branch, `main`).
 * The single most decisive answer to "did *this change* break it?": if the test
 * already fails on the baseline, the failure was not introduced here. Generic —
 * the baseline is any reference run, however you obtained it (CI, a prior run,
 * a vendor's main-branch history). No provider is assumed.
 */
export const BaselineSchema = z.object({
  failed: z
    .boolean()
    .describe("Whether the same test also fails on the baseline (target branch)."),
  ref: z
    .string()
    .optional()
    .describe("The baseline reference, e.g. 'main' or a commit SHA. Traceability only."),
  runUrl: z.string().optional().describe("Link to the baseline run, if any."),
});
export type Baseline = z.infer<typeof BaselineSchema>;

/** Where/when the failure happened. Traceability only; not used by the expertise yet. */
export const RunContextSchema = z.object({
  runNumber: z.number().int().nonnegative().optional(),
  runUrl: z.string().optional(),
  branch: z.string().optional(),
  commit: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type RunContext = z.infer<typeof RunContextSchema>;

/** The normalized observation a triage operates on. */
export const FlakyTriageInputSchema = z.object({
  testId: z.string().min(1).describe("Stable identifier, e.g. file + full title."),
  title: z.string().optional().describe("Human-readable test title."),
  filePath: z.string().optional().describe("Spec file the test lives in."),
  attempts: z
    .array(TestAttemptSchema)
    .min(1)
    .describe("All attempts of this test in a single run, in order."),
  history: TestHistorySchema.optional(),
  changedInDiff: z
    .boolean()
    .optional()
    .describe(
      "Whether the test file (or code it exercises) changed in the diff under test. " +
        "A deterministic failure on changed code points to a real regression, not flake.",
    ),
  // --- Additive, optional. Populated by cloud adapters (e.g. Cypress Cloud). ---
  // The core expertise never requires these; they enrich it when present.
  baseline: BaselineSchema.optional(),
  artifacts: ArtifactsSchema.optional(),
  vendorSignals: VendorSignalsSchema.optional(),
  runContext: RunContextSchema.optional(),
});
export type FlakyTriageInput = z.infer<typeof FlakyTriageInputSchema>;

/**
 * The classification a QA engineer would reach. Note the two distinct flaky
 * families (infra/timing vs. race) — they have *different* fixes — and the
 * explicit "not flaky" verdict, which must never be quarantined away.
 */
export const ClassificationSchema = z.enum([
  "flaky_infrastructure", // network, environment, timeouts, runner health
  "flaky_race_condition", // app/test race: detached nodes, unstable elements, ordering
  "flaky_data_or_state", // shared state / test-order / fixture contamination
  "test_or_config_error", // deterministic, but the *test* is broken: bad/undefined input, missing env/fixture
  "likely_real_regression", // deterministic, assertion-based — a real *product* bug
  "inconclusive", // not enough signal to decide
]);
export type Classification = z.infer<typeof ClassificationSchema>;

/** A single piece of reasoning linking an observation to the verdict. */
export const EvidenceSchema = z.object({
  signal: z.string().describe("Named signal, e.g. passed-on-retry."),
  observation: z.string().describe("What was actually seen in the input."),
  points: z.enum([
    "flaky_infrastructure",
    "flaky_race_condition",
    "flaky_data_or_state",
    "test_or_config_error",
    "regression",
    // Orthogonal to the root-cause families: it doesn't say *why* the test
    // fails, only that this change didn't introduce it. Excluded from the vote.
    "pre_existing",
  ]),
  weight: z.number().min(0).max(1).describe("How strongly this signal argues its direction."),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/**
 * The safe-repair contract for a classification. Encodes what a Staff QA engineer
 * will and will not do to a test — framework-agnostic. `forbidden` is the load-
 * bearing half: it is how we stop an agent "fixing" a test by hiding a real bug
 * (sleeping, weakening assertions, skipping, retrying a regression away).
 */
export const RepairContractSchema = z.object({
  allowed: z.array(z.string()).describe("Repairs a QA engineer may apply for this classification."),
  forbidden: z
    .array(z.string())
    .describe("Repairs that must never be applied — they mask defects rather than fix flake."),
});
export type RepairContract = z.infer<typeof RepairContractSchema>;

/** A concrete next step, prioritized the way a Staff QA would sequence it. */
export const RecommendedActionSchema = z.object({
  action: z.string(),
  rationale: z.string(),
  priority: z.enum(["now", "next", "later"]),
});
export type RecommendedAction = z.infer<typeof RecommendedActionSchema>;

/** The structured judgment — the actual product of this capability. */
export const FlakyTriageJudgmentSchema = z.object({
  testId: z.string(),
  classification: ClassificationSchema,
  confidence: z.number().min(0).max(1),
  summary: z.string().describe("One-line assessment a human can act on."),
  evidence: z.array(EvidenceSchema),
  recommendedActions: z.array(RecommendedActionSchema),
  safeRepairs: RepairContractSchema.describe(
    "Allowed vs forbidden repairs for this classification — the guardrails an agent must honour.",
  ),
  preExisting: z
    .boolean()
    .describe(
      "True when the same test also fails on the baseline — the failure was not introduced by " +
        "the change under test. Orthogonal to the classification; a pre-existing failure can still " +
        "be a real bug, it just isn't *this* change's fault.",
    ),
  quarantineRecommended: z
    .boolean()
    .describe("Whether to quarantine the test to unblock the pipeline while investigating."),
  quarantineForbidden: z
    .boolean()
    .describe("True when the failure looks like a real regression — quarantining would hide a bug."),
});
export type FlakyTriageJudgment = z.infer<typeof FlakyTriageJudgmentSchema>;
