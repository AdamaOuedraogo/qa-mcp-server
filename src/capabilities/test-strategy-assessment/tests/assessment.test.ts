import { test } from "node:test";
import assert from "node:assert/strict";
import { assessTestStrategy } from "../evaluator.js";
import type { TestStrategyObservation } from "../schema.js";

/**
 * Pins the expertise: which practices a consultant flags, that unknowns become
 * questions (never gaps), and that services follow from gaps. Run with:
 *   node --import tsx --test src/capabilities/test-strategy-assessment/tests/*.test.ts
 */

const immature: TestStrategyObservation = {
  strategy: {
    documentExists: "no",
    riskBasedPrioritisation: "no",
    testLayers: { unit: "ad_hoc", integration_or_component: "none", api_or_contract: "none", e2e_ui: "systematic", non_functional: "none" },
    entryExitCriteria: "none",
    traceability: "none",
  },
  automation: {
    ownership: "qa_only",
    standardsDocumented: "no",
    standardsEnforced: "no",
    testsReviewedInMergeRequests: "no",
    testData: "shared_fixtures",
    environments: "shared_unstable",
    serviceCatalog: "none",
  },
  ci: { gate: "nightly_only", feedbackTimeMinutes: 75, flakyPolicy: "retry_and_ignore", reportingAndTrends: "per_run_html" },
  people: { communityOfPractice: "none", coachingOrOnboarding: "none", aiAssistance: "individual_experiments" },
};

const mature: TestStrategyObservation = {
  strategy: {
    documentExists: "living",
    riskBasedPrioritisation: "explicit",
    testLayers: { unit: "systematic", integration_or_component: "systematic", api_or_contract: "systematic", e2e_ui: "systematic", non_functional: "ad_hoc" },
    entryExitCriteria: "defined",
    traceability: "tooled",
  },
  automation: {
    ownership: "shared",
    standardsDocumented: "yes",
    standardsEnforced: "lint_and_review",
    testsReviewedInMergeRequests: "always",
    testData: "seeded_or_synthetic_per_test",
    environments: "ephemeral_or_per_branch",
    serviceCatalog: "published",
  },
  ci: { gate: "on_merge_request_plus_nightly", feedbackTimeMinutes: 12, flakyPolicy: "quarantine_with_ticket_and_expiry", reportingAndTrends: "dashboard_with_trends" },
  people: { communityOfPractice: "regular_with_backlog", coachingOrOnboarding: "structured", aiAssistance: "governed_pilot" },
};

test("an immature practice yields high-severity gaps on every axis and a full service set", () => {
  const j = assessTestStrategy(immature);
  const ids = j.gaps.map((g) => g.id);
  for (const id of ["STR-001", "STR-002", "STR-003", "AUT-001", "AUT-002", "AUT-006", "CI-001", "CI-002", "CI-003", "PPL-001", "PPL-003"]) {
    assert.ok(ids.includes(id), `${id} expected`);
  }
  assert.ok(!ids.includes("AUT-003"), "enforcement gap only applies when standards exist");
  assert.equal(j.gaps.find((g) => g.id === "STR-003")!.title, "Inverted test pyramid (E2E carries the load)");
  assert.ok(j.overallLevel <= 1);
  assert.equal(j.openQuestions.length, 0);
  assert.equal(j.confidence, 1);
  assert.ok(j.services.length >= 5);
  assert.ok(j.plan["30_days"].length >= 3);
  assert.ok(j.gaps[0]!.severity === "high", "sorted by severity");
});

test("a mature practice has no high gaps and scores managed or better", () => {
  const j = assessTestStrategy(mature);
  assert.equal(j.gaps.filter((g) => g.severity === "critical" || g.severity === "high").length, 0);
  assert.ok(j.overallLevel >= 3, `got ${j.overallLevel}`);
  assert.equal(j.services.length, 0);
});

test("unknown answers become questions and lower confidence, never gaps", () => {
  const o: TestStrategyObservation = JSON.parse(JSON.stringify(mature));
  o.ci.gate = "unknown";
  o.ci.flakyPolicy = "unknown";
  o.people.communityOfPractice = "unknown";
  delete (o.ci as { feedbackTimeMinutes?: number }).feedbackTimeMinutes;
  const j = assessTestStrategy(o);
  assert.equal(j.gaps.filter((g) => g.axis === "ci_and_feedback").length, 0);
  const fields = j.openQuestions.map((q) => q.field);
  assert.deepEqual(fields.sort(), ["ci.feedbackTimeMinutes", "ci.flakyPolicy", "ci.gate", "people.communityOfPractice"]);
  assert.ok(j.confidence < 1);
  const ci = j.axes.find((a) => a.axis === "ci_and_feedback")!;
  assert.ok(ci.level <= 2, "unknowns cap an axis at 'defined'");
});

test("no CI gate at all is critical", () => {
  const o: TestStrategyObservation = JSON.parse(JSON.stringify(mature));
  o.ci.gate = "none";
  const j = assessTestStrategy(o);
  assert.equal(j.gaps.find((g) => g.id === "CI-001")!.severity, "critical");
  assert.ok(j.axes.find((a) => a.axis === "ci_and_feedback")!.level <= 1);
});

test("deterministic", () => {
  assert.deepEqual(assessTestStrategy(immature), assessTestStrategy(immature));
});
