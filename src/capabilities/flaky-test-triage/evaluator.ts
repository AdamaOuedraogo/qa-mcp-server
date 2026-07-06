import {
  FlakyTriageInputSchema,
  type FlakyTriageInput,
  type FlakyTriageJudgment,
} from "./schema.js";
import { applyVendorPriors, classify, collectEvidence, recommendActions } from "./rules.js";

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

  const recommendedActions = recommendActions(classification, input);

  const quarantineForbidden = classification === "likely_real_regression";
  const quarantineRecommended =
    !quarantineForbidden &&
    classification !== "inconclusive" &&
    confidence >= 0.6;

  const summary = prior.note
    ? `${summarize(classification, confidence)} ${prior.note}`
    : summarize(classification, confidence);

  return {
    testId: input.testId,
    classification,
    confidence,
    summary,
    evidence,
    recommendedActions,
    quarantineRecommended,
    quarantineForbidden,
  };
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
    case "likely_real_regression":
      return `Likely a REAL regression — deterministic failure, do not quarantine (${pct}% confidence).`;
    case "inconclusive":
    default:
      return `Inconclusive — not enough signal to decide flake vs. regression (${pct}% confidence).`;
  }
}
