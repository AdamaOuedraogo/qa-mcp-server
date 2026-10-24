import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const AUDIT_RUBRIC_MARKDOWN = `# QA Audit Rubric

The maturity model behind \`audit_test_suite\` and \`assess_test_strategy\`.
Use it to read their scores, to run an audit by hand, and to explain a verdict
to a team in their own terms.

## Levels

| Level | Label | Meaning |
| --- | --- | --- |
| 0 | absent | The practice does not exist. |
| 1 | ad hoc | It exists in places, depends on individuals, is not written down. |
| 2 | defined | Written and known; applied inconsistently. |
| 3 | managed | Applied consistently, enforced (lint, review, CI), with an owner. |
| 4 | optimized | Measured over time and improved on evidence. |

A static audit never awards 4 on its own: "optimized" needs run data and a
trend. Treat 3 as the realistic ceiling of a code-only review.

## Code-level axes (\`audit_test_suite\`)

- **Reliability** — no fixed sleeps, no forced actions, no conditional test
  bodies, retries kept to one and recorded, auth state reused.
- **Maintainability** — user-facing locators, a thin abstraction layer, no
  hard-coded URLs, typed and linted test code, small specs.
- **Feedback speed** — parallel-safe tests, sharded CI job, cached
  dependencies/browsers, critical subset on merge requests.
- **Coverage & risk** — journeys tagged by priority, no committed \`.only\`,
  skips triaged, every test asserts, CI gate on merge requests + nightly full run.
- **Observability** — JSON/JUnit reporters, traces/screenshots on failure,
  artifacts published, JUnit wired to the CI test tab.
- **Governance** — no secrets in code, a written testing guide, a lockfile,
  one script to run the suite the same way locally and in CI.

## Practice-level axes (\`assess_test_strategy\`)

- **Strategy & risk** — a living strategy, explicit risk-based prioritisation,
  balanced test layers, testing in the Definition of Done, traceability.
- **Automation practice** — shared ownership, documented and enforced
  standards, reviewed tests, per-test data, stable or ephemeral environments,
  a published automation service offer.
- **CI & feedback** — gate on merge requests, fast feedback (< 15–20 min),
  a flaky policy (triage, quarantine with ticket and expiry), trends.
- **People & adoption** — community of practice with a backlog, coaching path,
  governed use of AI assistance.

## Severity

- **critical** — hides coverage or exposes secrets (\`.only\`, no CI gate,
  credentials in code). Fix before anything else.
- **high** — drives most of the flake, cost or risk; first 30 days.
- **medium** — structural; needs a workstream the team owns.
- **low** — hygiene; bundle into the standard.

## How to run the two-day audit with these capabilities

1. **Diagnose (day 1).** \`audit_test_suite\` on the repository; collect the
   last 20–30 CI runs and run \`triage_flaky_test\` on retried tests; fill
   \`assess_test_strategy\` from the strategy doc and two short interviews.
2. **Prototype (day 2).** Open one pull request on the top hotspot files
   applying the quick wins; wire reporters/artifacts if missing.
3. **Adopt (hand-over).** Deliver the findings, the 30/60/90 plan and the
   standard; agree owners for the structural workstreams.
`;

/**
 * Resource: qa://audit-rubric
 * The maturity model and severity scale used by the audit capabilities.
 */
export function registerAuditRubric(server: McpServer): void {
  server.registerResource(
    "audit-rubric",
    "qa://audit-rubric",
    {
      title: "QA Audit Rubric",
      description: "Maturity levels, axes and severity scale behind audit_test_suite and assess_test_strategy.",
      mimeType: "text/markdown",
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: AUDIT_RUBRIC_MARKDOWN }] }),
  );
}
