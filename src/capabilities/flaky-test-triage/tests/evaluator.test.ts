import { test } from "node:test";
import assert from "node:assert/strict";
import { triageFlakyTest } from "../evaluator.js";
import { fromPlaywrightJson } from "../adapters.js";

/**
 * These tests pin the *expertise*, not just the plumbing. Each case is a triage
 * an experienced QA engineer would recognize. Run with:
 *   node --import tsx --test src/capabilities/flaky-test-triage/tests/*.test.ts
 */

test("passed-on-retry is judged flaky, never a regression", () => {
  const j = triageFlakyTest({
    testId: "checkout.spec.ts :: completes an order",
    attempts: [
      { attempt: 0, status: "timedOut", errorType: "TimeoutError", errorMessage: "waiting for selector '#pay'" },
      { attempt: 1, status: "passed" },
    ],
  });
  assert.equal(j.classification, "flaky_infrastructure");
  assert.equal(j.quarantineForbidden, false);
  assert.ok(j.confidence >= 0.8, `expected high confidence, got ${j.confidence}`);
  assert.ok(j.evidence.some((e) => e.signal === "passed-on-retry"));
});

test("deterministic assertion failure on changed code is a real regression — do not quarantine", () => {
  const j = triageFlakyTest({
    testId: "cart.spec.ts :: shows correct total",
    changedInDiff: true,
    attempts: [
      { attempt: 0, status: "failed", errorType: "AssertionError", errorMessage: "expected 42 to equal 40" },
      { attempt: 1, status: "failed", errorType: "AssertionError", errorMessage: "expected 42 to equal 40" },
    ],
  });
  assert.equal(j.classification, "likely_real_regression");
  assert.equal(j.quarantineForbidden, true);
  assert.equal(j.quarantineRecommended, false);
});

test("network error is classed as infrastructure flake", () => {
  const j = triageFlakyTest({
    testId: "api.spec.ts :: loads dashboard",
    attempts: [{ attempt: 0, status: "failed", errorMessage: "request failed: ECONNREFUSED 127.0.0.1:5432" }],
  });
  assert.equal(j.classification, "flaky_infrastructure");
});

test("detached-node error is classed as a race condition", () => {
  const j = triageFlakyTest({
    testId: "menu.spec.ts :: opens dropdown",
    attempts: [{ attempt: 0, status: "failed", errorMessage: "element is detached from the DOM" }],
  });
  assert.equal(j.classification, "flaky_race_condition");
});

test("intermittent history alone yields a flaky verdict", () => {
  const j = triageFlakyTest({
    testId: "search.spec.ts :: returns results",
    attempts: [{ attempt: 0, status: "failed", errorMessage: "Error: something" }],
    history: { runs: 20, failures: 6, distinctErrorMessages: 3 },
  });
  assert.equal(j.classification, "flaky_infrastructure");
  assert.ok(j.evidence.some((e) => e.signal === "intermittent-history"));
});

test("adapter normalizes Playwright JSON into observations", () => {
  const report = {
    suites: [
      {
        file: "login.spec.ts",
        specs: [
          {
            title: "signs in",
            tests: [
              {
                results: [
                  { status: "failed", duration: 3000, error: { message: "TimeoutError: waiting for selector" } },
                  { status: "passed", duration: 1200 },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const observations = fromPlaywrightJson(report);
  assert.equal(observations.length, 1);
  const j = triageFlakyTest(observations[0]!);
  assert.equal(j.classification, "flaky_infrastructure");
});
