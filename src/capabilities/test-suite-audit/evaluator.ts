import {
  TestSuiteObservationSchema,
  type TestSuiteAuditJudgment,
  type TestSuiteObservation,
} from "./schema.js";
import {
  LEVEL_LABELS,
  caveats,
  collectFindings,
  overallLevel,
  planActions,
  rankHotspots,
  scoreAxes,
} from "./rules.js";

/**
 * The capability entry point: an observation in, an audit judgment out.
 * Pure and deterministic — the same observation always yields the same audit,
 * which is what makes the expertise testable and worth trusting in front of a
 * client.
 */
export function auditTestSuite(rawObservation: TestSuiteObservation): TestSuiteAuditJudgment {
  const obs = TestSuiteObservationSchema.parse(rawObservation);

  const findings = collectFindings(obs);
  const axes = scoreAxes(obs, findings);
  const level = overallLevel(axes);
  const hotspots = rankHotspots(obs.specs);
  const actionPlan = planActions(obs, findings);
  const quickWinCount = findings.filter((f) => f.quickWin).length;

  const specs = obs.specs;
  const metrics = {
    specFiles: specs.length,
    tests: specs.reduce((a, s) => a + s.tests, 0),
    hardWaits: specs.reduce((a, s) => a + s.hardWaits.length, 0),
    skippedTests: specs.reduce((a, s) => a + s.skippedTests.length, 0),
    focusedTests: specs.reduce((a, s) => a + s.focusedTests.length, 0),
    fragileSelectors: specs.reduce((a, s) => a + s.fragileSelectors.length, 0),
    specsWithSemanticLocators: specs.filter((s) => s.usesSemanticLocators).length,
    specsWithPageObjects: specs.filter((s) => s.usesPageObjectOrFixture).length,
    specsWithPriorityTags: specs.filter((s) => s.priorityTags.length > 0).length,
  };

  const critical = findings.filter((f) => f.severity === "critical").length;
  const high = findings.filter((f) => f.severity === "high").length;
  const weakest = [...axes].sort((a, b) => a.level - b.level)[0];

  const headline = `${obs.framework === "unknown" ? "Test suite" : capitalize(obs.framework) + " suite"} at maturity level ${level}/4 (${LEVEL_LABELS[level]}) — ${findings.length} finding(s), ${critical} critical, ${quickWinCount} fixable in a short PR.`;

  const summary = [
    `${metrics.specFiles} spec file(s) / ${metrics.tests} test(s) analysed${obs.totalSpecFilesFound > metrics.specFiles ? ` (of ${obs.totalSpecFilesFound} found)` : ""}.`,
    weakest ? `Weakest axis: ${weakest.axis.replace(/_/g, " ")} (${weakest.label}).` : "",
    critical
      ? `${critical} critical issue(s) must be fixed before anything else.`
      : high
        ? `${high} high-severity issue(s) drive most of the risk.`
        : "No critical or high-severity issue; the work is structural.",
    hotspots.length ? `Start with ${Math.min(hotspots.length, 5)} hotspot spec file(s) — they concentrate the smells.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    headline,
    summary,
    overallLevel: level,
    overallLabel: LEVEL_LABELS[level]!,
    axes,
    findings,
    hotspots,
    actionPlan,
    quickWinCount,
    metrics,
    caveats: caveats(obs),
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
