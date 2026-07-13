import {
  FlakyTriageInputSchema,
  type FlakyTriageInput,
  type FlakyTriageJudgment,
  type RecommendedAction,
} from "./schema.js";
import {
  applyVendorPriors,
  classify,
  collectEvidence,
  isPreExisting,
  recommendActions,
} from "./rules.js";
import { repairsFor } from "./repairs.js";

/**
 * The capability entry point: a normalized observation in, a structured QA
 * judgment out. Pure and deterministic — same input always yields the same
 * judgment, which is what makes the expertise testable and trustworthy.
 *
 * This function is the whole contract. It returns *judgment*, never the input's
 * raw numbers. That is what separates a capability from a connector.
 */
export function triageFlakyTest(rawInput: FlakyTriageInput): FlakyTriageJudgment {
  const input = FlakyTriageInputSchema.parse(rawInput);

  const evidence = collectEvidence(input);
  const base = classify(evidence);

  // Fold in any vendor prior (e.g. Cypress Cloud's flaky verdict). Priors adjust
  // confidence only; they never override the local verdict — the safety guard
  // against quarantining a real regression lives in classify(), untouched here.
  const prior = applyVendorPriors(base, input.vendorSignals);
  const { classification, confidence } = prior;

  // Was this failure already present on the baseline? If so it wasn't introduced
  // by the change under test. This is orthogonal to the root cause: a pre-existing
  // failure can still be a real bug — it just isn't *this* change's fault.
  const preExisting = isPreExisting(input);

  const recommendedActions = withPreExisting(
    recommendActions(classification, input),
    preExisting,
  );

  // A real regression is never safe to quarantine — even a pre-existing one, which
  // is still a real bug. Pre-existing only changes *who* should act, not whether
  // the bug may be hidden.
  const quarantineForbidden = classification === "likely_real_regression";
  const quarantineRecommended =
    !quarantineForbidden &&
    classification !== "inconclusive" &&
    // A broken test isn't "unblock-and-move-on" material — it should be fixed, not
    // quarantined as if it were environmental flake.
    classification !== "test_or_config_error" &&
    confidence >= 0.6;

  const safeRepairs = repairsFor(classification);

  const parts = [summarize(classification, confidence)];
  if (preExisting) {
    parts.push("This failure already exists on the baseline — it was not introduced by this change.");
  }
  if (prior.note) parts.push(prior.note);
  const summary = parts.join(" ");

  return {
    testId: input.testId,
    classification,
    confidence,
    summary,
    evidence,
    recommendedActions,
    safeRepairs,
    preExisting,
    quarantineRecommended,
    quarantineForbidden,
  };
}

/**
 * When the failure predates the change under test, lead with that: attributing a
 * pre-existing failure to this change misdirects the fix and can block unrelated
 * merges. The family actions still follow — the bug is real and still needs work.
 */
function withPreExisting(actions: RecommendedAction[], preExisting: boolean): RecommendedAction[] {
  if (!preExisting) return actions;
  return [
    {
      action:
        "This failure predates the change under test (it also fails on the baseline). Do not block " +
        "this change for it; route it to the baseline's owner and track it separately.",
      rationale:
        "A pre-existing failure is real work, but blaming this change misdirects the investigation " +
        "and blocks unrelated merges. It is still a bug — it just isn't this change's bug.",
      priority: "now",
    },
    ...actions,
  ];
}

function summarize(classification: FlakyTriageJudgment["classification"], confidence: number): string {
  const pct = Math.round(confidence * 100);
  switch (classification) {
    case "flaky_infrastructure":
      return `Likely flaky — infrastructure/timing, not a product bug (${pct}% confidence).`;
    case "flaky_race_condition":
      return `Likely flaky — a race condition in the test/app, fixable in the test (${pct}% confidence).`;
    case "flaky_data_or_state":
      return `Likely flaky — shared data/state or test ordering (${pct}% confidence).`;
    case "test_or_config_error":
      return `Broken test / config — deterministic, but the defect is in the test setup, not the product (${pct}% confidence).`;
    case "likely_real_regression":
      return `Likely a REAL regression — deterministic failure, do not quarantine (${pct}% confidence).`;
    case "inconclusive":
    default:
      return `Inconclusive — not enough signal to decide flake vs. regression (${pct}% confidence).`;
  }
}
