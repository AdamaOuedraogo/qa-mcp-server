import { TestStrategyObservationSchema, type TestStrategyJudgment, type TestStrategyObservation } from "./schema.js";
import { LEVEL_LABELS, collectGaps, openQuestions, overallLevel, plan, scoreAxes, suggestServices, unknownShare } from "./rules.js";

/**
 * Observation (what the team says and writes) in, judgment out. Pure and
 * deterministic. Unknown answers lower confidence and become questions; they
 * never become gaps.
 */
export function assessTestStrategy(raw: TestStrategyObservation): TestStrategyJudgment {
  const o = TestStrategyObservationSchema.parse(raw);
  const gaps = collectGaps(o);
  const axes = scoreAxes(o, gaps);
  const level = overallLevel(axes.map((a) => a.level));
  const questions = openQuestions(o);
  const services = suggestServices(gaps);
  const unknown = unknownShare(o);
  const confidence = Math.round((1 - unknown) * 100) / 100;

  const critical = gaps.filter((g) => g.severity === "critical").length;
  const high = gaps.filter((g) => g.severity === "high").length;
  const weakest = [...axes].sort((a, b) => a.level - b.level)[0];

  const headline = `Testing practice at level ${level}/4 (${LEVEL_LABELS[level]}) — ${gaps.length} gap(s), ${critical} critical, ${questions.length} open question(s); confidence ${Math.round(confidence * 100)}%.`;
  const summary = [
    weakest ? `Weakest axis: ${weakest.axis.replace(/_/g, " ")} (${weakest.label}).` : "",
    critical ? "A critical gap means tests do not currently protect releases; start there." : high ? `${high} high-severity gap(s) shape the first 30 days.` : "No high-severity gap; the work is consolidation.",
    questions.length ? `${questions.length} answer(s) are unknown — ask them before quoting this assessment.` : "All questions answered.",
    services.length ? `Suggested services: ${services.map((s) => s.title).join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    headline,
    summary,
    axes,
    overallLevel: level,
    overallLabel: LEVEL_LABELS[level]!,
    gaps,
    openQuestions: questions,
    plan: plan(gaps),
    services,
    confidence,
  };
}
