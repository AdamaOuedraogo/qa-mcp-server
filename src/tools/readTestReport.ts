import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const MAX_REPORT_CHARS = 20_000;

/**
 * Tool: read_test_report
 *
 * Reads a test report file (JSON, XML, or text) from disk and returns its
 * contents, truncated to a safe size. This does not execute anything; it is a
 * simple, bounded file reader for QA report artifacts.
 */
export function registerReadTestReport(server: McpServer): void {
  server.registerTool(
    "read_test_report",
    {
      title: "Read Test Report",
      description:
        "Read a test report artifact (e.g. Playwright JSON reporter output, " +
        "JUnit XML, or a text summary) and return its contents, truncated to a " +
        "safe size for analysis.",
      inputSchema: {
        reportPath: z
          .string()
          .optional()
          .describe(
            "Path to the report file, e.g. playwright-report/results.json. " +
              "Defaults to a common Playwright report location.",
          ),
      },
    },
    async ({ reportPath }) => {
      const target = reportPath ?? "playwright-report/results.json";
      const absolute = resolve(process.cwd(), target);

      try {
        const raw = await readFile(absolute, "utf8");
        const truncated = raw.length > MAX_REPORT_CHARS;
        const body = truncated ? raw.slice(0, MAX_REPORT_CHARS) : raw;

        const text = [
          `Report: ${target}`,
          `Resolved path: ${absolute}`,
          `Size: ${raw.length} characters${truncated ? " (truncated)" : ""}`,
          "",
          "----- BEGIN REPORT -----",
          body,
          "----- END REPORT -----",
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `Could not read report at "${target}" (resolved: ${absolute}).\n` +
                `Reason: ${message}\n\n` +
                "Provide a valid reportPath, or run your tests with a file " +
                "reporter first (e.g. Playwright's json reporter).",
            },
          ],
        };
      }
    },
  );
}
