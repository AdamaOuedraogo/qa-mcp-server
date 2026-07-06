import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { triageFlakyTest } from "./evaluator.js";
import type { FlakyTriageInput, FlakyTriageJudgment } from "./schema.js";

/**
 * Capability: triage_flaky_test
 *
 * The reference "QA Expertise Capability". It does not return report data — it
 * returns a Staff-QA-grade judgment: is this failure flaky or a real regression,
 * how confident are we, what is the evidence, and what should the team do. The
 * agent supplies a normalized observation; the expertise lives in ./rules.ts.
 */
export function registerTriageFlakyTest(server: McpServer): void {
  server.registerTool(
    "triage_flaky_test",
    {
      title: "Triage Flaky Test",
      description:
        "Judge whether a failing test is flaky (and which kind) or a real " +
        "regression, with confidence, evidence, and prioritized actions. Returns " +
        "a QA judgment, not raw report data. Feed it one test's attempts (retries) " +
        "and, if available, its recent pass/fail history.",
      inputSchema: {
        testId: z.string().min(1).describe("Stable id, e.g. 'login.spec.ts :: signs in'."),
        title: z.string().optional().describe("Human-readable test title."),
        filePath: z.string().optional().describe("Spec file the test lives in."),
        attempts: z
          .array(
            z.object({
              attempt: z.number().int().nonnegative(),
              status: z.enum(["passed", "failed", "timedOut", "skipped"]),
              durationMs: z.number().nonnegative().optional(),
              errorType: z.string().optional(),
              errorMessage: z.string().optional(),
            }),
          )
          .min(1)
          .describe("Every attempt of this test in one run, in order (retries included)."),
        history: z
          .object({
            runs: z.number().int().positive(),
            failures: z.number().int().nonnegative(),
            distinctErrorMessages: z.number().int().positive().optional(),
          })
          .optional()
          .describe("Recent cross-run stats, if tracked. Strengthens the verdict."),
        changedInDiff: z
          .boolean()
          .optional()
          .describe("Whether the test or the code it exercises changed in the diff under test."),
        artifacts: z
          .object({
            testReplayUrl: z.string().optional(),
            screenshotUrl: z.string().optional(),
            videoUrl: z.string().optional(),
          })
          .optional()
          .describe("Evidence links (e.g. Cypress Test Replay). Carried through, not parsed yet."),
        vendorSignals: z
          .object({
            isFlakyVendorVerdict: z.boolean().optional(),
            flakinessRate: z.number().min(0).max(1).optional(),
            severity: z.enum(["high", "medium", "low"]).optional(),
          })
          .optional()
          .describe("Vendor-computed flaky signals (e.g. Cypress Cloud). Used as confidence priors."),
        runContext: z
          .object({
            runNumber: z.number().int().nonnegative().optional(),
            runUrl: z.string().optional(),
            branch: z.string().optional(),
            commit: z.string().optional(),
            tags: z.array(z.string()).optional(),
          })
          .optional()
          .describe("Run traceability (run number/URL, branch, commit, tags)."),
      },
    },
    async (input) => {
      const judgment = triageFlakyTest(input as FlakyTriageInput);
      return { content: [{ type: "text", text: render(judgment) }] };
    },
  );
}

/** Render for humans, but always include the machine-readable judgment for agents. */
function render(j: FlakyTriageJudgment): string {
  const lines = [
    `# Flaky Test Triage — ${j.testId}`,
    "",
    `**Verdict:** ${j.summary}`,
    `**Classification:** ${j.classification}`,
    `**Confidence:** ${Math.round(j.confidence * 100)}%`,
    j.quarantineForbidden
      ? "**Quarantine:** ⛔ FORBIDDEN — this looks like a real bug; quarantining would ship it."
      : `**Quarantine:** ${j.quarantineRecommended ? "recommended to unblock the pipeline while investigating" : "not recommended yet"}`,
    "",
    "## Evidence",
    ...(j.evidence.length
      ? j.evidence.map((e) => `- **${e.signal}** (→ ${e.points}, weight ${e.weight}): ${e.observation}`)
      : ["- (no signals fired — inconclusive)"]),
    "",
    "## Recommended actions",
    ...j.recommendedActions.map((a) => `- _[${a.priority}]_ **${a.action}**\n  ${a.rationale}`),
    "",
    "## Judgment (JSON)",
    "```json",
    JSON.stringify(j, null, 2),
    "```",
  ];
  return lines.join("\n");
}
