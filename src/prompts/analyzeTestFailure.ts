import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Prompt: analyze-test-failure
 *
 * A reusable prompt that guides an LLM to analyze a failing test using the
 * available evidence: report output, trace, screenshot, and logs.
 */
export function registerAnalyzeTestFailure(server: McpServer): void {
  server.registerPrompt(
    "analyze-test-failure",
    {
      title: "Analyze Test Failure",
      description:
        "Analyze a failing test using report output, trace, screenshot, and " +
        "logs, and propose a root cause and next steps.",
      argsSchema: {
        testName: z.string().optional().describe("Name of the failing test."),
        reportOutput: z
          .string()
          .optional()
          .describe("Reporter output or error message / stack trace."),
        traceSummary: z
          .string()
          .optional()
          .describe("Summary of the Playwright trace or step timeline."),
        logs: z.string().optional().describe("Relevant application or console logs."),
      },
    },
    ({ testName, reportOutput, traceSummary, logs }) => {
      const text = [
        "You are a senior QA engineer triaging a failing end-to-end test.",
        "Analyze the evidence and determine the most likely root cause.",
        "",
        `## Failing test\n${testName?.trim() || "(name not provided)"}`,
        "",
        `## Reporter output / error\n${reportOutput?.trim() || "(not provided)"}`,
        "",
        `## Trace summary\n${traceSummary?.trim() || "(not provided)"}`,
        "",
        `## Logs\n${logs?.trim() || "(not provided)"}`,
        "",
        "## Produce",
        "1. **Most likely root cause** — one clear statement.",
        "2. **Classification** — product bug, flaky test, environment/setup, " +
          "or test-code issue.",
        "3. **Evidence** — which parts of the input support your conclusion.",
        "4. **Recommended fix** — concrete next step (code or config).",
        "5. **Confidence** — low / medium / high, and what extra artifact " +
          "(trace, screenshot, log) would raise it.",
        "",
        "If the evidence is insufficient, say so and list exactly what to collect.",
      ].join("\n");

      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text },
          },
        ],
      };
    },
  );
}
