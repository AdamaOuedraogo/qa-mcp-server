import type {
  Classification,
  Evidence,
  FlakyTriageInput,
  RecommendedAction,
  TestAttempt,
  VendorSignals,
} from "./schema.js";

/**
 * The expertise.
 *
 * This file is the point of the whole project: it encodes how a Staff QA
 * engineer reasons about a failing test, not how to fetch one. Each detector is
 * a pure function from a normalized observation to a piece of evidence. The
 * classifier then weighs the evidence the way an experienced engineer would.
 *
 * The reasoning, in plain language, lives in ./docs/reasoning.md. Keep the two
 * in sync — the prose is the spec, this file is the implementation.
 */

// --- Pattern vocabulary -----------------------------------------------------
// These patterns come from real triage, not documentation. They intentionally
// match on the *message text* because that is what reporters actually give you.

const TIMEOUT_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /exceeded .*ms/i,
  /waiting for (selector|locator|element|response)/i,
  /waiting until/i,
];

const INFRA_PATTERNS = [
  /econnrefused/i,
  /econnreset/i,
  /etimedout/i,
  /enotfound/i,
  /socket hang up/i,
  /net::err/i,
  /getaddrinfo/i,
  /\b50[234]\b/, // 502/503/504 from a dependency
  /connection (refused|reset|closed)/i,
  /dns/i,
];

const RACE_PATTERNS = [
  /detached from (the )?dom/i,
  /element is not attached/i,
  /not stable/i,
  /is not visible/i,
  /intercepts pointer events/i,
  /element is outside of the viewport/i,
  /animation/i,
  /stale element/i,
];

const DATA_STATE_PATTERNS = [
  /already exists/i,
  /duplicate key/i,
  /unique constraint/i,
  /not found/i, // a record another test was supposed to create
  /expected .* rows/i,
  /seed/i,
];

const ASSERTION_PATTERNS = [
  /assertionerror/i,
  /expect\(/i,
  /to (equal|be|contain|have)/i,
  /expected .* (to|but) /i,
  /deep equal/i,
];

// The test itself is broken or misconfigured: it fed an undefined/invalid value,
// dereferenced nothing, or a required env/fixture was absent. Deterministic, but
// the fix is in the *test/config*, not the product — and it is NOT flake.
const CONFIG_ERROR_PATTERNS = [
  /can only accept/i, // framework arg guards, e.g. cy.type/select
  /passed in.*(undefined|null)/i,
  /cannot read propert(y|ies) of (undefined|null)/i,
  /(undefined|null) is not (an? )?(object|function|iterable)/i,
  /is not a function/i,
  /is not defined/i, // ReferenceError
  /require is not defined/i, // test bundling/config, not infra
  /(is required|is not set)\b/i,
  /missing (required )?(env|environment|config|configuration|variable|fixture|credential)/i,
  /fixture .*(not found|does not exist)/i,
];

function anyMatch(text: string | undefined, patterns: RegExp[]): boolean {
  if (!text) return false;
  return patterns.some((p) => p.test(text));
}

function failedAttempts(attempts: TestAttempt[]): TestAttempt[] {
  return attempts.filter((a) => a.status === "failed" || a.status === "timedOut");
}

function messageOf(a: TestAttempt): string {
  return [a.errorType, a.errorMessage].filter(Boolean).join(": ");
}

// --- Signal detectors -------------------------------------------------------
// Each returns Evidence or null. Weights are calibrated so that a single
// decisive signal (passed-on-retry) can carry a verdict, while weaker signals
// must corroborate.

/**
 * The decisive one. Same test, same commit, one attempt failed and a later one
 * passed. By definition the code is not deterministically broken → flaky. We
 * point it at the family suggested by the *failing* attempt's message.
 */
function passedOnRetry(input: FlakyTriageInput): Evidence | null {
  const { attempts } = input;
  const failedFirst = attempts.some((a) => a.status === "failed" || a.status === "timedOut");
  const passedLater = attempts.some((a) => a.status === "passed");
  if (!(failedFirst && passedLater)) return null;

  const failing = failedAttempts(attempts)[0];
  const msg = messageOf(failing);
  const points = anyMatch(msg, RACE_PATTERNS)
    ? "flaky_race_condition"
    : anyMatch(msg, INFRA_PATTERNS)
      ? "flaky_infrastructure"
      : anyMatch(msg, TIMEOUT_PATTERNS)
        ? "flaky_infrastructure"
        : "flaky_infrastructure";

  return {
    signal: "passed-on-retry",
    observation: `Failed on attempt ${failing.attempt}, passed on a later retry at the same commit.`,
    points,
    weight: 0.95,
  };
}

/** Timeout / waiting errors: timing-sensitive, usually infra or under-provisioned runners. */
function timeoutError(input: FlakyTriageInput): Evidence | null {
  const hit = failedAttempts(input.attempts).find(
    (a) => a.status === "timedOut" || anyMatch(messageOf(a), TIMEOUT_PATTERNS),
  );
  if (!hit) return null;
  return {
    signal: "timeout-error",
    observation: `Failure is a timeout / waiting error: "${messageOf(hit).slice(0, 140)}".`,
    points: "flaky_infrastructure",
    weight: 0.5,
  };
}

/** Network / dependency / runner errors: environmental, not the code under test. */
function infraError(input: FlakyTriageInput): Evidence | null {
  const hit = failedAttempts(input.attempts).find((a) => anyMatch(messageOf(a), INFRA_PATTERNS));
  if (!hit) return null;
  return {
    signal: "infrastructure-error",
    observation: `Failure references network/environment: "${messageOf(hit).slice(0, 140)}".`,
    points: "flaky_infrastructure",
    weight: 0.7,
  };
}

/** Race conditions: detached/unstable elements, animations, pointer interception. */
function raceCondition(input: FlakyTriageInput): Evidence | null {
  const hit = failedAttempts(input.attempts).find((a) => anyMatch(messageOf(a), RACE_PATTERNS));
  if (!hit) return null;
  return {
    signal: "race-condition",
    observation: `Failure references a UI race: "${messageOf(hit).slice(0, 140)}".`,
    points: "flaky_race_condition",
    weight: 0.7,
  };
}

/** Shared-state / ordering contamination. */
function dataOrStateContamination(input: FlakyTriageInput): Evidence | null {
  const hit = failedAttempts(input.attempts).find((a) => anyMatch(messageOf(a), DATA_STATE_PATTERNS));
  if (!hit) return null;
  return {
    signal: "data-or-state",
    observation: `Failure suggests shared data/state or test ordering: "${messageOf(hit).slice(0, 140)}".`,
    points: "flaky_data_or_state",
    weight: 0.55,
  };
}

/** Intermittent history: a pass rate strictly between "always" and "never" is flake by definition. */
function intermittentHistory(input: FlakyTriageInput): Evidence | null {
  const h = input.history;
  if (!h || h.runs < 5) return null;
  const failRate = h.failures / h.runs;
  if (failRate <= 0.02 || failRate >= 0.98) return null; // deterministic either way
  return {
    signal: "intermittent-history",
    observation: `Failed ${h.failures}/${h.runs} recent runs (${Math.round(failRate * 100)}%) — intermittent.`,
    points: "flaky_infrastructure",
    weight: 0.6,
  };
}

/** Volatile error messages across history: non-determinism, a hallmark of flake. */
function volatileErrors(input: FlakyTriageInput): Evidence | null {
  const h = input.history;
  if (!h?.distinctErrorMessages || h.distinctErrorMessages < 2) return null;
  return {
    signal: "volatile-error-messages",
    observation: `${h.distinctErrorMessages} distinct failure messages across recent runs.`,
    points: "flaky_infrastructure",
    weight: 0.45,
  };
}

/**
 * The test is broken, not the product. An argument-type error (undefined passed
 * to an interaction), a null dereference, a ReferenceError, or a missing
 * env/fixture. Deterministic like a regression, but it fails *before* it can
 * exercise the product — so calling it a regression sends the engineer to bisect
 * product commits that are innocent. High weight so it outranks the generic
 * deterministic-regression signal it would otherwise be mistaken for.
 */
function testOrConfigError(input: FlakyTriageInput): Evidence | null {
  const hit = failedAttempts(input.attempts).find((a) => anyMatch(messageOf(a), CONFIG_ERROR_PATTERNS));
  if (!hit) return null;
  return {
    signal: "test-or-config-error",
    observation: `Failure is a broken-test/config error, not a product assertion: "${messageOf(hit).slice(0, 140)}".`,
    points: "test_or_config_error",
    weight: 0.75,
  };
}

/**
 * The counter-signal. Every attempt failed with the *same* assertion error, no
 * retry ever passed. This is deterministic. If the code under test also changed
 * in the diff, this is almost certainly a real regression — and must NOT be
 * quarantined, or the bug ships.
 */
function deterministicRegression(input: FlakyTriageInput): Evidence | null {
  const failed = failedAttempts(input.attempts);
  const anyPass = input.attempts.some((a) => a.status === "passed");
  if (anyPass || failed.length < input.attempts.length) return null; // something passed → not this
  const messages = new Set(failed.map((a) => messageOf(a)));
  const stable = messages.size === 1;
  const assertion = failed.some((a) => anyMatch(messageOf(a), ASSERTION_PATTERNS));
  if (!stable && !assertion) return null;

  const changedBoost = input.changedInDiff ? 0.25 : 0;
  const base = assertion ? 0.6 : 0.4;
  return {
    signal: "deterministic-assertion-failure",
    observation:
      `All ${failed.length} attempt(s) failed identically` +
      (assertion ? " on an assertion" : "") +
      (input.changedInDiff ? "; the code under test changed in this diff." : "."),
    points: "regression",
    weight: Math.min(0.95, base + changedBoost),
  };
}

/**
 * Cross-reference with the baseline. If the *same test* also fails on the target
 * branch, this change did not introduce the failure. This is orthogonal to the
 * root cause — the test may be flaky or genuinely broken — so this evidence does
 * NOT vote for a family (see `bucketOf`). It sets the `preExisting` flag, which
 * relaxes "block this change" without ever relaxing "this might be a real bug".
 */
function failsOnBaseline(input: FlakyTriageInput): Evidence | null {
  if (input.baseline?.failed !== true) return null;
  const ref = input.baseline.ref ? ` (${input.baseline.ref})` : "";
  return {
    signal: "fails-on-baseline",
    observation: `The same test already fails on the baseline${ref} — not introduced by this change.`,
    points: "pre_existing",
    weight: 0.9,
  };
}

const DETECTORS: Array<(i: FlakyTriageInput) => Evidence | null> = [
  passedOnRetry,
  timeoutError,
  infraError,
  raceCondition,
  dataOrStateContamination,
  intermittentHistory,
  volatileErrors,
  testOrConfigError,
  deterministicRegression,
  failsOnBaseline,
];

/** Run every detector and keep the signals that fired. */
export function collectEvidence(input: FlakyTriageInput): Evidence[] {
  return DETECTORS.map((d) => d(input)).filter((e): e is Evidence => e !== null);
}

// --- Classification ---------------------------------------------------------

const BUCKETS: Classification[] = [
  "flaky_infrastructure",
  "flaky_race_condition",
  "flaky_data_or_state",
  "test_or_config_error",
  "likely_real_regression",
];

/**
 * Map a piece of evidence to the family it votes for, or null if it is not a
 * root-cause vote (e.g. `pre_existing`, which is orthogonal to the families).
 */
function bucketOf(e: Evidence): Classification | null {
  if (e.points === "pre_existing") return null;
  return e.points === "regression" ? "likely_real_regression" : e.points;
}

/** Whether the observation was already failing on the baseline (target branch). */
export function isPreExisting(input: FlakyTriageInput): boolean {
  return input.baseline?.failed === true;
}

/**
 * Weigh the evidence. We sum weights per bucket, pick the strongest, and derive
 * confidence from how dominant it is. A lone strong signal (e.g. passed-on-retry
 * at 0.95) still yields high confidence; scattered weak signals stay uncertain.
 */
export function classify(evidence: Evidence[]): {
  classification: Classification;
  confidence: number;
} {
  if (evidence.length === 0) {
    return { classification: "inconclusive", confidence: 0.2 };
  }

  const totals = new Map<Classification, number>();
  for (const b of BUCKETS) totals.set(b, 0);
  for (const e of evidence) {
    const b = bucketOf(e);
    if (b === null) continue; // orthogonal evidence (e.g. pre_existing) doesn't vote
    totals.set(b, (totals.get(b) ?? 0) + e.weight);
  }

  let best: Classification = "inconclusive";
  let bestScore = 0;
  let sum = 0;
  for (const [bucket, score] of totals) {
    sum += score;
    if (score > bestScore) {
      bestScore = score;
      best = bucket;
    }
  }

  if (bestScore === 0) return { classification: "inconclusive", confidence: 0.2 };

  // Dominance of the winning bucket, nudged up by the strongest single signal so
  // that one decisive detector isn't diluted by weak noise.
  const dominance = bestScore / sum;
  const peak = Math.max(...evidence.filter((e) => bucketOf(e) === best).map((e) => e.weight));
  const confidence = Math.min(0.98, Math.max(0.25, 0.5 * dominance + 0.5 * peak));

  return { classification: best, confidence: Number(confidence.toFixed(2)) };
}

// --- Actions ----------------------------------------------------------------
// The fix depends on the family. Note that we never recommend "just add a retry"
// for a race or a regression — retries hide races and ship regressions.

export function recommendActions(
  classification: Classification,
  input: FlakyTriageInput,
): RecommendedAction[] {
  switch (classification) {
    case "flaky_infrastructure":
      return [
        {
          action: "Quarantine the test to unblock the pipeline, tagged with this triage.",
          rationale: "The failure is environmental, not a product bug — it should not block merges.",
          priority: "now",
        },
        {
          action: "Check dependency/runner health at the failure timestamps (5xx, DNS, CPU, network).",
          rationale: "Infra flake correlates with degraded dependencies or under-provisioned runners.",
          priority: "next",
        },
        {
          action: "Stub or contract-test the flaky external dependency instead of hitting it live in E2E.",
          rationale: "Removes the environmental variance at its source rather than masking it with retries.",
          priority: "later",
        },
      ];
    case "flaky_race_condition":
      return [
        {
          action: "Replace hard waits / manual sleeps with web-first, auto-retrying assertions.",
          rationale: "Race flake comes from asserting before the app settled; auto-waiting removes the race.",
          priority: "now",
        },
        {
          action: "Wait for the element to be stable/attached before interacting; assert on state, not timing.",
          rationale: "Detached-node and pointer-interception errors are ordering bugs in the test.",
          priority: "next",
        },
        {
          action: "Do NOT paper over this with retries — retries hide the race and it will resurface.",
          rationale: "The defect is real non-determinism in the test; retries only lower its frequency.",
          priority: "next",
        },
      ];
    case "flaky_data_or_state":
      return [
        {
          action: "Isolate test data: unique fixtures per test, and reset/seed state in setup.",
          rationale: "Shared state and test-order coupling cause intermittent, order-dependent failures.",
          priority: "now",
        },
        {
          action: "Run the suite in a randomized order in CI to surface hidden ordering dependencies.",
          rationale: "Makes contamination reproducible instead of intermittent.",
          priority: "next",
        },
      ];
    case "test_or_config_error":
      return [
        {
          action:
            "Fix the test's input/configuration: supply the missing value (env var, fixture, " +
            "credential) or guard against it — the test fed an undefined/invalid value downstream.",
          rationale:
            "Deterministic, but the defect is in the test setup, not the product. It will pass once " +
            "the input/config is correct; no product change is needed.",
          priority: "now",
        },
        {
          action:
            "Make the test fail fast with a clear 'missing X' message when required config is absent, " +
            "instead of passing undefined into a framework call.",
          rationale:
            "Turns a cryptic framework error into an actionable signal and stops it from being " +
            "mis-triaged as a product regression.",
          priority: "next",
        },
        {
          action: "Do NOT bisect product commits or quarantine — the product is not implicated.",
          rationale: "This is broken coverage, not a shipped bug; treating it as either wastes effort.",
          priority: "next",
        },
      ];
    case "likely_real_regression":
      return [
        {
          action: "Do NOT quarantine. Treat as a failing gate and block the merge.",
          rationale: "The failure is deterministic and assertion-based — quarantining would ship the bug.",
          priority: "now",
        },
        {
          action: input.changedInDiff
            ? "Review the change in this diff that touches the code under test."
            : "Bisect recent commits to find the change that introduced the failure.",
          rationale: "A deterministic assertion failure has a root cause in code, not the environment.",
          priority: "now",
        },
      ];
    case "inconclusive":
    default:
      return [
        {
          action: "Collect more signal: retry once in CI, and pull this test's recent pass/fail history.",
          rationale: "A single deterministic-looking failure without history or a retry is ambiguous.",
          priority: "now",
        },
      ];
  }
}

// --- Vendor priors ----------------------------------------------------------
// A vendor (e.g. Cypress Cloud) may already have flagged this test as flaky, with
// a rate and a severity. We consume that as a *prior*: it can raise or lower our
// confidence, but it never sets the verdict. Most importantly, a vendor "flaky"
// flag must never override a deterministic-regression finding — doing so could
// quarantine a real bug behind a green pipeline.

export function applyVendorPriors(
  base: { classification: Classification; confidence: number },
  vendor: VendorSignals | undefined,
): { classification: Classification; confidence: number; note?: string } {
  if (!vendor) return base;

  const saysFlaky =
    vendor.isFlakyVendorVerdict === true ||
    (typeof vendor.flakinessRate === "number" &&
      vendor.flakinessRate > 0.02 &&
      vendor.flakinessRate < 0.98);
  if (!saysFlaky) return base;

  const strength = vendor.severity === "high" ? 0.15 : vendor.severity === "medium" ? 0.1 : 0.06;
  const round = (n: number) => Number(n.toFixed(2));

  // Conflict: the local expertise says real regression. The vendor prior loses —
  // we keep the verdict, lower confidence to reflect the disagreement, and flag it.
  if (base.classification === "likely_real_regression") {
    return {
      classification: base.classification,
      confidence: round(Math.max(0.25, base.confidence - strength)),
      note:
        "Note: the vendor flags this test as flaky, which conflicts with the " +
        "deterministic-regression signal. Verdict kept — a vendor prior must not hide a " +
        "real bug — but the disagreement is worth investigating.",
    };
  }

  // Agreement: we already see a flaky family → the independent vendor flag raises confidence.
  if (base.classification !== "inconclusive") {
    return {
      classification: base.classification,
      confidence: round(Math.min(0.98, base.confidence + strength)),
      note: "Confidence raised: the vendor independently flags this test as flaky.",
    };
  }

  // Inconclusive locally, but the vendor has cross-run history we don't. We can't
  // invent a family, so we stay inconclusive and nudge confidence, noting the gap.
  return {
    classification: base.classification,
    confidence: round(Math.min(0.6, base.confidence + strength)),
    note:
      "The vendor flags this test as flaky, but no local signal indicates which family. " +
      "Collect attempt-level detail (retries, error messages) to classify and resolve it.",
  };
}
