import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sanitizeArg } from "../utils/command.js";
import { getExecutionConfig, isLiveExecutionEnabled } from "../config.js";
import { ExecutionError, renderRunResult, runInProject } from "../execution/adapter.js";

/**
 * Tool: run_playwright_test
 *
 * A *controlled* tool (not a generic terminal). It accepts a small, typed set
 * of QA-relevant parameters. By default it is a dry run (returns the exact
 * Playwright command). When live execution is enabled via configuration, it
 * runs Playwright inside the configured project directory through the execution
 * adapter (the single security boundary).
 */
export function registerRunPlaywrightTest(server: McpServer): void {
  server.registerTool(
    "run_playwright_test",
    {
      title: "Run Playwright Test",
      description:
        "Run a Playwright test from safe, typed parameters. Dry-run by default " +
        "(returns the exact command); executes for real only when live " +
        "execution is enabled. Controlled tool — no arbitrary shell input.",
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

      // Dry-run (default): describe the command without executing anything.
      if (!isLiveExecutionEnabled()) {
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
          "Live execution is disabled. To enable it, set QA_MCP_EXECUTION_MODE=live " +
            "and QA_MCP_PROJECT_DIR to the absolute path of a Playwright project.",
        ].join("\n");

        return { content: [{ type: "text", text: summary }] };
      }

      // Live: run through the execution adapter (security boundary).
      const { projectDir } = getExecutionConfig();
      try {
        const result = await runInProject(args);
        return {
          content: [
            { type: "text", text: renderRunResult("Playwright", command, projectDir!, result) },
          ],
        };
      } catch (err) {
        const message = err instanceof ExecutionError ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: `Playwright run could not start: ${message}` }],
        };
      }
    },
  );
}
