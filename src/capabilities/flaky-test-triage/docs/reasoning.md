# The reasoning behind Flaky Test Triage

This document is the spec. `rules.ts` is its implementation. When they disagree,
this file is right and the code is a bug.

The goal is not to detect that a test failed — any reporter does that. The goal
is to answer the question a Staff QA engineer answers in seconds and a dashboard
never does: **is this failure the test's fault or the product's fault, and what
do we do about it?**

## The one question that splits everything

> Did the *same test* at the *same commit* produce *different outcomes*?

If yes, the code under test is not deterministically broken — the test is
non-deterministic. That is the definition of flaky. This is why **passed-on-retry**
is the strongest signal we have (weight 0.95): a fail followed by a pass, same
code, is near-proof of flake. No amount of log-reading beats it.

If a test fails *identically every time*, it is deterministic. Deterministic
failures are almost never "flaky" — they are regressions wearing a flaky costume.
Calling them flaky and retrying them is how bugs ship.

## The families (because the fix differs)

We don't just say "flaky". A flaky verdict is useless without a family, because
each family has a *different* fix:

| Classification            | What it means                                   | The fix is in… |
| ------------------------- | ----------------------------------------------- | -------------- |
| `flaky_infrastructure`    | Network, dependency 5xx, DNS, timeouts, runners | the environment |
| `flaky_race_condition`    | Detached nodes, unstable elements, animations   | the test/app code |
| `flaky_data_or_state`     | Shared fixtures, unique-constraint clashes, order| test isolation |
| `likely_real_regression`  | Deterministic, assertion-based                  | the product code |
| `inconclusive`            | Not enough signal                               | collect more |

Two flaky tests with the same red X can need opposite work. A dashboard that
only counts failures erases exactly the distinction that matters.

## The signals, and why each one weighs what it does

- **passed-on-retry (0.95)** — decisive; see above.
- **infrastructure-error (0.70)** — `ECONNREFUSED`, `net::ERR`, 5xx, DNS: the
  failure names the environment, not the assertion. High weight, but below retry
  because a genuine dependency outage can also be a real problem to fix.
- **race-condition (0.70)** — "detached from the DOM", "not stable", pointer
  interception: the test acted before the app settled.
- **timeout-error (0.50)** — timing-sensitive; often infra, but a timeout can
  also mask a real hang, so it corroborates rather than decides.
- **intermittent-history (0.60)** — a pass rate strictly between ~2% and ~98%
  over ≥5 runs is flake by definition, independent of retries.
- **volatile-error-messages (0.45)** — different failure text across runs is
  non-determinism; weak alone, strong in company.
- **data-or-state (0.55)** — unique-constraint / "already exists" / "not found":
  classic shared-state or test-order contamination.
- **deterministic-assertion-failure (0.60, +0.25 if changed in diff)** — the
  counter-signal. Every attempt failed identically, nothing passed, and it looks
  like an assertion. If the code under test also changed in this diff, this is a
  regression and the confidence climbs.

## How the verdict is formed

Sum the weights per family, take the strongest, and set confidence from (a) how
dominant that family is over the others and (b) the single strongest signal in
it. That second term is deliberate: one decisive detector should not be diluted
into "maybe" by a couple of weak, unrelated signals.

## The rule that protects the team

`likely_real_regression` sets `quarantineForbidden = true`. The capability will
refuse to recommend quarantine, and the prompt forbids the agent from retrying
the failure away. Quarantining a deterministic assertion failure is how a real
bug reaches production behind a green pipeline. This capability exists partly to
make that mistake structurally hard.

## Anti-patterns this capability refuses to endorse

- **"Just add `retries: 2`."** Retries lower a race's frequency; they do not fix
  it, and they hide regressions outright.
- **"Increase the timeout."** Sometimes right for infra, never right for a race,
  and it slows every green run to paper over one red one.
- **"Quarantine and move on."** Fine for infra flake with a follow-up; unsafe for
  anything deterministic.
