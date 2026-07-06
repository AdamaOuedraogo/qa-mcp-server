# Worked examples

Two triages that look identical on a dashboard (a red test) and get opposite
verdicts from the expertise.

## 1. Flaky infrastructure — safe to quarantine

**Observation** (a timeout that passed on retry):

```json
{
  "testId": "checkout.spec.ts :: completes an order",
  "attempts": [
    { "attempt": 0, "status": "timedOut", "errorType": "TimeoutError", "errorMessage": "waiting for selector '#pay-button'" },
    { "attempt": 1, "status": "passed" }
  ]
}
```

**Judgment:**

```json
{
  "classification": "flaky_infrastructure",
  "confidence": 0.9,
  "summary": "Likely flaky — infrastructure/timing, not a product bug (90% confidence).",
  "evidence": [
    { "signal": "passed-on-retry", "points": "flaky_infrastructure", "weight": 0.95,
      "observation": "Failed on attempt 0, passed on a later retry at the same commit." },
    { "signal": "timeout-error", "points": "flaky_infrastructure", "weight": 0.5,
      "observation": "Failure is a timeout / waiting error." }
  ],
  "quarantineRecommended": true,
  "quarantineForbidden": false
}
```

Same code passed on retry → not a product bug. Quarantine to unblock, investigate
runner/dependency health.

## 2. Real regression — quarantine forbidden

**Observation** (deterministic assertion, code changed in the diff):

```json
{
  "testId": "cart.spec.ts :: shows correct total",
  "changedInDiff": true,
  "attempts": [
    { "attempt": 0, "status": "failed", "errorType": "AssertionError", "errorMessage": "expected 42 to equal 40" },
    { "attempt": 1, "status": "failed", "errorType": "AssertionError", "errorMessage": "expected 42 to equal 40" }
  ]
}
```

**Judgment:**

```json
{
  "classification": "likely_real_regression",
  "confidence": 0.85,
  "summary": "Likely a REAL regression — deterministic failure, do not quarantine (85% confidence).",
  "evidence": [
    { "signal": "deterministic-assertion-failure", "points": "regression", "weight": 0.85,
      "observation": "All 2 attempt(s) failed identically on an assertion; the code under test changed in this diff." }
  ],
  "quarantineRecommended": false,
  "quarantineForbidden": true
}
```

Every attempt failed identically on an assertion, and the code changed. This is a
bug. The capability refuses to quarantine it — retrying it away would ship the bug
behind a green pipeline.
