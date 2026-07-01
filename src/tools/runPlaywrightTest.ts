import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sanitizeArg } from "../utils/command.js";

/**
 * Tool: run_playwright_test
 *
 * A *controlled* tool (not a generic terminal). It accepts a small, typed set
 * of QA-relevant parameters and describes the exact Playwright command that
 * would run. Actual execution is intentionally left as an opt-in follow-up so
 * the MVP stays safe by default.
 */
export function registerRunPlaywrightTest(server: McpServer): void {
  server.registerTool(
    "run_playwright_test",
    {
      title: "Run Playwright Test",
      description:
        "Prepare a Playwright test run from safe, typed parameters. Returns the " +
        "exact command that would be executed. This is a controlled tool — it " +
        "does not accept arbitrary shell input.",
      inputSchema: {
        testPath: z
          .string()
          .optional()
          .describe("Path to a spec file or directory, e.g. tests/login.spec.ts"),
        headed: z
          .boolean()
          .optional()
          .describe("Run with a visible browser (headed mode) instead of headless."),
        project: z
          .string()
          .optional()
          .describe("Playwright project name, e.g. chromium, firefox, webkit."),
      },
    },
    async ({ testPath, headed, project }) => {
      // Strip control characters from caller-supplied values before they land
      // in a command string a human may copy-paste (see sanitizeArg).
      const safeTestPath = testPath ? sanitizeArg(testPath) : undefined;
      const safeProject = project ? sanitizeArg(project) : undefined;

      const args = ["playwright", "test"];
      if (safeTestPath) args.push(safeTestPath);
      if (safeProject) args.push("--project", safeProject);
      if (headed) args.push("--headed");

      const command = `npx ${args.join(" ")}`;

      const summary = [
        "Prepared Playwright run (dry run — not executed).",
        "",
        `Command: ${command}`,
        "",
        "Parameters:",
        `- testPath: ${safeTestPath ?? "(all tests)"}`,
        `- project:  ${safeProject ?? "(default projects)"}`,
        `- headed:   ${headed ? "yes" : "no"}`,
        "",
        "To execute this for real, run the command above in the project that " +
          "has Playwright installed. Execution is disabled by default in this " +
          "MVP so the server is safe to connect to any client.",
      ].join("\n");

      return {
        content: [{ type: "text", text: summary }],
      };
    },
  );
}
