import { test } from "node:test";
import assert from "node:assert/strict";
import { triageFlakyTest } from "../evaluator.js";
import { fromPlaywrightJson, fromJUnitXml, parseTestReport } from "../adapters.js";

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

test("vendor flaky verdict raises confidence when the local verdict already agrees", () => {
  const observation = {
    testId: "search.spec.ts :: returns results",
    attempts: [{ attempt: 0, status: "failed" as const, errorMessage: "request failed: ECONNREFUSED" }],
  };
  const without = triageFlakyTest(observation);
  const withVendor = triageFlakyTest({
    ...observation,
    vendorSignals: { isFlakyVendorVerdict: true, severity: "high" as const },
  });
  assert.equal(withVendor.classification, without.classification); // verdict unchanged
  assert.ok(
    withVendor.confidence > without.confidence,
    `expected prior to raise confidence: ${without.confidence} -> ${withVendor.confidence}`,
  );
});

test("SAFETY: a vendor flaky verdict never overrides a real regression", () => {
  const j = triageFlakyTest({
    testId: "cart.spec.ts :: shows correct total",
    changedInDiff: true,
    vendorSignals: { isFlakyVendorVerdict: true, flakinessRate: 0.4, severity: "high" as const },
    attempts: [
      { attempt: 0, status: "failed", errorType: "AssertionError", errorMessage: "expected 42 to equal 40" },
      { attempt: 1, status: "failed", errorType: "AssertionError", errorMessage: "expected 42 to equal 40" },
    ],
  });
  assert.equal(j.classification, "likely_real_regression"); // prior must not flip it
  assert.equal(j.quarantineForbidden, true);
  assert.equal(j.quarantineRecommended, false);
});

test("baseline cross-reference marks a failure pre-existing without changing the family", () => {
  const observation = {
    testId: "orders.spec.ts :: lists open orders",
    attempts: [{ attempt: 0, status: "failed" as const, errorMessage: "request failed: ECONNREFUSED" }],
  };
  const local = triageFlakyTest(observation);
  const withBaseline = triageFlakyTest({ ...observation, baseline: { failed: true, ref: "main" } });

  assert.equal(withBaseline.classification, local.classification); // family unchanged by baseline
  assert.equal(local.preExisting, false);
  assert.equal(withBaseline.preExisting, true);
  assert.ok(withBaseline.evidence.some((e) => e.signal === "fails-on-baseline"));
  assert.ok(withBaseline.recommendedActions[0]!.action.toLowerCase().includes("predates"));
});

test("SAFETY: a pre-existing regression is still forbidden from quarantine", () => {
  const j = triageFlakyTest({
    testId: "cart.spec.ts :: shows correct total",
    baseline: { failed: true, ref: "main" },
    attempts: [
      { attempt: 0, status: "failed", errorType: "AssertionError", errorMessage: "expected 42 to equal 40" },
      { attempt: 1, status: "failed", errorType: "AssertionError", errorMessage: "expected 42 to equal 40" },
    ],
  });
  assert.equal(j.classification, "likely_real_regression");
  assert.equal(j.preExisting, true); // not this change's fault...
  assert.equal(j.quarantineForbidden, true); // ...but still a real bug — never hide it
});

test("safe-repair contract: real regression exposes no allowed test repair, always forbids sleeps", () => {
  const regression = triageFlakyTest({
    testId: "cart.spec.ts :: total",
    changedInDiff: true,
    attempts: [
      { attempt: 0, status: "failed", errorType: "AssertionError", errorMessage: "expected 42 to equal 40" },
      { attempt: 1, status: "failed", errorType: "AssertionError", errorMessage: "expected 42 to equal 40" },
    ],
  });
  assert.equal(regression.safeRepairs.allowed.length, 0);
  assert.ok(regression.safeRepairs.forbidden.some((r) => /sleep|delay/i.test(r)));

  const race = triageFlakyTest({
    testId: "menu.spec.ts :: opens dropdown",
    attempts: [{ attempt: 0, status: "failed", errorMessage: "element is detached from the DOM" }],
  });
  assert.ok(race.safeRepairs.allowed.length > 0);
  assert.ok(race.safeRepairs.forbidden.some((r) => /skip|disable/i.test(r)));
});

test("a broken-test/config error is not a product regression (real my-rental-app case)", () => {
  // The first real run: cy.type() got undefined because Cypress.env('LOGIN_PASSWORD') was unset.
  const j = triageFlakyTest({
    testId: "cypress/e2e/auth/login.feature :: signs in with valid credentials",
    attempts: [
      {
        attempt: 0,
        status: "failed",
        errorType: "CypressError",
        errorMessage: "`cy.type()` can only accept a string or number. You passed in: `undefined`",
      },
    ],
    history: { runs: 3, failures: 2, distinctErrorMessages: 1 },
  });
  assert.equal(j.classification, "test_or_config_error");
  assert.notEqual(j.classification, "likely_real_regression"); // the bug we shipped, then fixed
  assert.equal(j.quarantineForbidden, false); // not a product bug being hidden...
  assert.equal(j.quarantineRecommended, false); // ...but fix it, don't quarantine it
  assert.ok(j.safeRepairs.allowed.some((r) => /env|fixture|credential|input/i.test(r)));
});

test("null-dereference in a test is classed as a config/test error, not flake", () => {
  const j = triageFlakyTest({
    testId: "profile.spec.ts :: renders name",
    attempts: [{ attempt: 0, status: "failed", errorMessage: "TypeError: Cannot read properties of undefined (reading 'name')" }],
  });
  assert.equal(j.classification, "test_or_config_error");
});

test("JUnit adapter: mocha-junit shape resolves the spec file from a sibling suite (real my-rental-app)", () => {
  // Exactly the shape mocha-junit-reporter emits for Cypress here: `file` on the
  // Root Suite, the failing case in another suite, `name` carrying the suite prefix.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Mocha Tests" tests="1" failures="1">
  <testsuite name="Root Suite" file="cypress/e2e/auth/login.feature" tests="0" failures="0"></testsuite>
  <testsuite name="Authentication" tests="1" failures="1">
    <testcase name="Authentication Sign in with valid credentials redirects to the dashboard" classname="Sign in with valid credentials redirects to the dashboard" time="0.000">
      <failure message="\`cy.type()\` can only accept a string or number. You passed in: \`undefined\`" type="CypressError"><![CDATA[CypressError: \`cy.type()\` can only accept a string or number.]]></failure>
    </testcase>
  </testsuite>
</testsuites>`;
  const observations = fromJUnitXml(xml);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]!.filePath, "cypress/e2e/auth/login.feature");
  assert.equal(observations[0]!.testId.startsWith("cypress/e2e/auth/login.feature :: "), true);

  const j = triageFlakyTest(observations[0]!);
  assert.equal(j.classification, "test_or_config_error"); // full pipeline: XML → observation → verdict
});

test("JUnit adapter: passing tests parse as passed; failures carry the message", () => {
  const xml = `<testsuites>
    <testsuite name="checkout.spec.ts" file="checkout.spec.ts">
      <testcase name="completes an order" classname="checkout" time="1.2"/>
      <testcase name="loads dashboard" classname="checkout" time="6.1">
        <failure type="Error" message="request failed: ECONNREFUSED 127.0.0.1:5432">Error: connect ECONNREFUSED</failure>
      </testcase>
    </testsuite>
  </testsuites>`;
  const obs = fromJUnitXml(xml);
  assert.equal(obs.length, 2);
  const pass = obs.find((o) => o.testId.includes("completes an order"))!;
  const fail = obs.find((o) => o.testId.includes("loads dashboard"))!;
  assert.equal(pass.attempts[0]!.status, "passed");
  assert.equal(fail.attempts[0]!.status, "failed");
  assert.equal(triageFlakyTest(fail).classification, "flaky_infrastructure");
});

test("parseTestReport auto-detects JUnit XML vs Playwright JSON", () => {
  const junit = parseTestReport('<testsuites><testsuite name="a.spec.ts"><testcase name="t" classname="a"/></testsuite></testsuites>');
  assert.equal(junit.length, 1);

  const pw = parseTestReport({
    suites: [{ file: "login.spec.ts", specs: [{ title: "signs in", tests: [{ results: [{ status: "passed" }] }] }] }],
  });
  assert.equal(pw.length, 1);
  assert.equal(pw[0]!.filePath, "login.spec.ts");
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
