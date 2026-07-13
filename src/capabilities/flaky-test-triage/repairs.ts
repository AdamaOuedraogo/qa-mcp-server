import type { Classification, RepairContract } from "./schema.js";

/**
 * The safe-repair contract.
 *
 * A triage that only *names* a flake is half the job. The other half is knowing
 * what you are allowed to change to fix it — and, more importantly, what you are
 * never allowed to change. This file encodes that judgment as data so an agent
 * (or a junior engineer) inherits the guardrails instead of learning them the
 * hard way, in production.
 *
 * It is deliberately framework-agnostic. The original expertise was written
 * against one stack; the *rules* generalize — "replace a fixed sleep with a
 * condition-based wait" is true whether the wait is `cy.wait`, `page.waitFor`,
 * or `await expect(...).toBeVisible()`. Concrete API names are intentionally
 * absent so the contract holds across Playwright, Cypress, WebdriverIO, etc.
 *
 * The `forbidden` half is the load-bearing one. Every entry is a real way teams
 * make a red test green while leaving the defect in place: sleeping, weakening
 * an assertion, forcing an interaction, skipping, blanket-retrying. Encoding
 * them as an explicit deny-list is what makes "don't hide the bug" enforceable.
 */

/**
 * Forbidden everywhere, regardless of classification. These do not fix flake;
 * they suppress the symptom and, in the regression case, ship the bug.
 */
const UNIVERSAL_FORBIDDEN: readonly string[] = [
  "Add or increase an arbitrary fixed sleep (a hard-coded delay) to 'stabilize' the test.",
  "Weaken, loosen, or remove an assertion so the failure stops surfacing.",
  "Force an interaction past the framework's actionability checks (e.g. a force/ignore-visibility flag).",
  "Skip, disable, or comment out the test instead of quarantining it with a tracked follow-up.",
  "Blanket-increase retries to make an intermittent failure disappear.",
  "Change an expected value to match observed-but-wrong app behaviour.",
  "Modify application/source code to make a test pass — triage repairs test code only; a product bug is reported, not patched here.",
];

/**
 * Allowed repairs per family. Empty `allowed` (real regression) is intentional:
 * there is no *test* repair for a genuine bug — you fix the product or revert.
 */
const ALLOWED_BY_FAMILY: Record<Classification, readonly string[]> = {
  flaky_infrastructure: [
    "Quarantine the test with a tracked follow-up (owner + ticket) so it stops blocking merges while the dependency is stabilized.",
    "Add an explicit, reasonable timeout for a genuinely slow-but-healthy dependency (a bounded wait, never an open-ended sleep).",
    "Stub, mock, or contract-test the unstable external dependency instead of hitting it live in an E2E test.",
    "Retry only the narrow network operation with backoff — never the whole test — when the flake is true external contention.",
  ],
  flaky_race_condition: [
    "Replace fixed waits with web-first, auto-retrying assertions that wait for the awaited state.",
    "Wait for the element to be attached, visible, and stable before interacting with it.",
    "Assert on application state or a settled condition rather than on elapsed time.",
    "Add a missing await / synchronization in test setup or teardown.",
  ],
  flaky_data_or_state: [
    "Give each test its own unique fixtures/data so runs cannot collide.",
    "Reset or seed state in setup so the test does not depend on another test's leftovers.",
    "Remove ordering coupling; run the suite in randomized order in CI to surface hidden dependencies.",
  ],
  test_or_config_error: [
    "Supply the missing input the test needs: load the env var / fixture / credential, or pass the correct value.",
    "Guard required configuration — assert it is present and fail fast with a clear message before the test uses it.",
    "Keep the fix in test/config code; the product is not implicated by a broken test input.",
  ],
  likely_real_regression: [
    // No test-level repair. The fix belongs in product code or a revert.
  ],
  inconclusive: [
    "Do not repair yet — collect more signal first (retry once in CI, pull recent pass/fail history).",
  ],
};

/**
 * Regression carries a sharper deny-list on top of the universal one: for a real
 * bug, *any* edit to the test that changes the outcome is suspect.
 */
const REGRESSION_EXTRA_FORBIDDEN: readonly string[] = [
  "Adjust the test in any way that makes the deterministic failure pass — that would be hiding a real bug.",
  "Quarantine or retry the failure to unblock the pipeline — a deterministic assertion failure is a gate, not flake.",
];

/** The safe-repair contract for a classification. */
export function repairsFor(classification: Classification): RepairContract {
  const allowed = [...(ALLOWED_BY_FAMILY[classification] ?? [])];
  const forbidden = [...UNIVERSAL_FORBIDDEN];
  if (classification === "likely_real_regression") {
    forbidden.push(...REGRESSION_EXTRA_FORBIDDEN);
  }
  return { allowed, forbidden };
}
