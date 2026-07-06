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
  "likely_real_regression", // deterministic, assertion-based — a real bug
  "inconclusive", // not enough signal to decide
]);
export type Classification = z.infer<typeof ClassificationSchema>;

/** A single piece of reasoning linking an observation to the verdict. */
export const EvidenceSchema = z.object({
  signal: z.string().describe("Named signal, e.g. passed-on-retry."),
  observation: z.string().describe("What was actually seen in the input."),
  points: z.enum(["flaky_infrastructure", "flaky_race_condition", "flaky_data_or_state", "regression"]),
  weight: z.number().min(0).max(1).describe("How strongly this signal argues its direction."),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

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
  quarantineRecommended: z
    .boolean()
    .describe("Whether to quarantine the test to unblock the pipeline while investigating."),
  quarantineForbidden: z
    .boolean()
    .describe("True when the failure looks like a real regression — quarantining would hide a bug."),
});
export type FlakyTriageJudgment = z.infer<typeof FlakyTriageJudgmentSchema>;
