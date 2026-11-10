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
import { redactObservation } from "./redact.js";

/**
 * The capability entry point: an observation in, an audit judgment out.
 * Pure and deterministic — the same observation always yields the same audit,
 * which is what makes the expertise testable and worth trusting in front of a
 * client.
 */
export function auditTestSuite(rawObservation: TestSuiteObservation): TestSuiteAuditJudgment {
  // Redact at the boundary: the observation may come from the scanner (which
  // already masks what it recognises) or straight from the caller (which may
  // not). Either way nothing credential-looking reaches the judgment.
  const obs = redactObservation(TestSuiteObservationSchema.parse(rawObservation));

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

  const completeness = computeCompleteness(obs);
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
    completeness.score < 1 ? `Scan completeness ${Math.round(completeness.score * 100)}% — ${completeness.notes.join("; ")}.` : "",
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
    completeness,
    caveats: caveats(obs),
  };
}

/**
 * How much of the expected input the scan actually saw. A static audit of a
 * root that holds no runner config and no CI file is not "absent on every
 * axis" — it is incomplete, and the reader needs to know before quoting it.
 */
function computeCompleteness(obs: TestSuiteObservation): TestSuiteAuditJudgment["completeness"] {
  const notes: string[] = [];
  const runnerConfigFound = Boolean(obs.runnerConfig.configFile);
  const ciDefinitionFound = obs.ci.provider !== "none";
  const packageJsonFound = Boolean(obs.repo.packageJsonFound);
  const specsFound = obs.totalSpecFilesFound;
  const specsAnalysed = obs.specs.length;
  if (!runnerConfigFound) notes.push("runner config not found (retries, reporters, traces, parallelism not judged)");
  if (!ciDefinitionFound) notes.push("no CI definition found (gate, artifacts, sharding not judged)");
  if (!packageJsonFound) notes.push("package.json not found or unparsable (scripts, dependencies not judged)");
  if (specsFound > specsAnalysed) notes.push(`${specsFound - specsAnalysed} spec file(s) counted but not analysed`);
  if (specsFound === 0) notes.push("no spec files found");
  const specShare = specsFound === 0 ? 0 : specsAnalysed / specsFound;
  const score = Math.round(((specShare * 2 + (runnerConfigFound ? 1 : 0) + (ciDefinitionFound ? 1 : 0) + (packageJsonFound ? 1 : 0)) / 5) * 100) / 100;
  return { score, specsAnalysed, specsFound, runnerConfigFound, ciDefinitionFound, packageJsonFound, notes };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
