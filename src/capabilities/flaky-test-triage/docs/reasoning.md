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
| `test_or_config_error`    | Undefined/invalid input, null deref, missing env/fixture | the test/config |
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
- **test-or-config-error (0.75)** — the test broke *before* it could exercise the
  product: `undefined` passed to an interaction, a null dereference, a
  ReferenceError, a missing env/fixture. Deterministic like a regression, so it
  outweighs the generic deterministic signal on purpose — otherwise an innocent
  product gets bisected for a broken test. Discovered the hard way: the first real
  run (a login test whose credential env was unset → `cy.type(undefined)`) was
  mislabelled `likely_real_regression` until this signal existed.
- **deterministic-assertion-failure (0.60, +0.25 if changed in diff)** — the
  counter-signal. Every attempt failed identically, nothing passed, and it looks
  like an assertion. If the code under test also changed in this diff, this is a
  regression and the confidence climbs.

## How the verdict is formed

Sum the weights per family, take the strongest, and set confidence from (a) how
dominant that family is over the others and (b) the single strongest signal in
it. That second term is deliberate: one decisive detector should not be diluted
into "maybe" by a couple of weak, unrelated signals.

## Cross-reference with the baseline (was it already broken?)

Two different questions decide who owns a failure, and they are independent:

- **`changedInDiff`** — *did this change touch the code under test?* A deterministic
  failure on code you just changed points straight at a regression you introduced.
- **`baseline.failed`** — *does the same test already fail on the target branch?* If
  yes, this change did not introduce it. We mark the judgment `preExisting`.

`preExisting` is deliberately **orthogonal to the family**. "Also fails on main"
tells you nothing about *why* it fails — it can be infra flake, a race, or a
genuine long-standing bug. So the baseline signal never votes for a family
(`bucketOf` returns null for it); it only sets a flag and reframes the actions:
*don't block this change for a failure it didn't cause — route it to the
baseline's owner and track it separately.* Crucially, `preExisting` does **not**
relax the quarantine guard: a pre-existing regression is still a real bug, so
`quarantineForbidden` stays true. Pre-existing changes *who acts*, never *whether
the bug may be hidden*.

## The safe-repair contract (what you may and may not change)

Naming a flake is half the job; the other half is bounding the fix. Each
classification carries a `safeRepairs` contract — `allowed` and `forbidden` —
lifted from real triage practice and made framework-agnostic (`repairs.ts`).

The `forbidden` half is the point. Every entry is a real way teams turn a red
test green while leaving the defect in place: adding a fixed sleep, weakening an
assertion, forcing an interaction, `.skip()`-ing, blanket-retrying, or editing
the expected value to match a bug. Encoding them as an explicit, per-family
deny-list is what makes "fix the flake, don't hide the bug" enforceable by an
agent instead of a matter of seniority. `likely_real_regression` has an **empty**
`allowed` list on purpose: there is no *test* repair for a genuine bug — you fix
the product or you revert.

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
