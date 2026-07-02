import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sanitizeArg } from "../utils/command.js";
import { getExecutionConfig, isLiveExecutionEnabled } from "../config.js";
import { ExecutionError, renderRunResult, runInProject } from "../execution/adapter.js";

/**
 * Tool: run_cypress_test
 *
 * A controlled tool that runs Cypress from typed parameters. By default it is a
 * dry run (returns the command it would execute). When live execution is
 * enabled via configuration, it runs Cypress inside the configured project
 * directory through the execution adapter (the single security boundary).
 */
export function registerRunCypressTest(server: McpServer): void {
  server.registerTool(
    "run_cypress_test",
    {
      title: "Run Cypress Test",
      description:
        "Run a Cypress test from safe, typed parameters. Dry-run by default " +
        "(returns the exact command); executes for real only when live " +
        "execution is enabled. Controlled tool — no arbitrary shell input.",
      inputSchema: {
        spec: z
          .string()
          .optional()
          .describe("Glob or path to a spec file, e.g. cypress/e2e/login.cy.ts"),
        browser: z
          .string()
          .optional()
          .describe("Browser to run in, e.g. chrome, firefox, electron."),
      },
    },
    async ({ spec, browser }) => {
      const safeSpec = spec ? sanitizeArg(spec) : undefined;
      const safeBrowser = browser ? sanitizeArg(browser) : undefined;

      const args = ["cypress", "run"];
      if (safeSpec) args.push("--spec", safeSpec);
      if (safeBrowser) args.push("--browser", safeBrowser);

      const command = `npx ${args.join(" ")}`;

      // Dry-run (default): describe the command without executing anything.
      if (!isLiveExecutionEnabled()) {
        const summary = [
          "Prepared Cypress run (dry run — not executed).",
          "",
          `Command: ${command}`,
          "",
          "Parameters:",
          `- spec:    ${safeSpec ?? "(all specs)"}`,
          `- browser: ${safeBrowser ?? "(default browser)"}`,
          "",
          "Live execution is disabled. To enable it, set QA_MCP_EXECUTION_MODE=live " +
            "and QA_MCP_PROJECT_DIR to the absolute path of a Cypress project.",
        ].join("\n");

        return { content: [{ type: "text", text: summary }] };
      }

      // Live: run through the execution adapter (security boundary).
      const { projectDir } = getExecutionConfig();
      try {
        const result = await runInProject(args);
        return {
          content: [
            { type: "text", text: renderRunResult("Cypress", command, projectDir!, result) },
          ],
        };
      } catch (err) {
        const message = err instanceof ExecutionError ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: `Cypress run could not start: ${message}` }],
        };
      }
    },
  );
}
