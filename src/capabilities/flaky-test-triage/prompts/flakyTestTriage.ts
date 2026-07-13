import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Prompt: flaky-test-triage
 *
 * Frames the agent to *use the capability's expertise* rather than improvise.
 * It tells the model how to assemble the observation and — crucially — the one
 * rule it must never break: never quarantine a likely regression.
 */
export function registerFlakyTestTriagePrompt(server: McpServer): void {
  server.registerPrompt(
    "flaky-test-triage",
    {
      title: "Flaky Test Triage",
      description:
        "Decide whether a failing test is flaky or a real regression, then act " +
        "on it — using the triage_flaky_test capability, not guesswork.",
      argsSchema: {
        testId: z.string().optional().describe("The failing test's id or title."),
        reportOutput: z
          .string()
          .optional()
          .describe("Reporter output: attempts, statuses, error messages, retries."),
        changedInDiff: z
          .string()
          .optional()
          .describe("'true' if the test or the code it exercises changed in this diff."),
      },
    },
    ({ testId, reportOutput, changedInDiff }) => {
      const text = [
        "You are triaging a failing end-to-end test the way a Staff QA engineer would.",
        "",
        "First, assemble a normalized observation from the evidence:",
        "- every attempt of the test in this run (retries matter most),",
        "- each attempt's status and first error line,",
        "- recent pass/fail history if you have it,",
        "- whether the code under test changed in the diff.",
        "",
        "Then call the **triage_flaky_test** capability with that observation. Do not",
        "improvise the verdict — the capability encodes the reasoning. Report its",
        "classification, confidence, evidence, and recommended actions.",
        "",
        "Hard rule: if the capability returns `likely_real_regression`, you must NOT",
        "quarantine or retry the test away. Surface it as a failing gate.",
        "",
        `## Test\n${testId?.trim() || "(id not provided)"}`,
        "",
        `## Reporter output\n${reportOutput?.trim() || "(not provided — collect it, then triage)"}`,
        "",
        `## Changed in diff\n${changedInDiff?.trim() || "(unknown)"}`,
      ].join("\n");

      return { messages: [{ role: "user", content: { type: "text", text } }] };
    },
  );
}
