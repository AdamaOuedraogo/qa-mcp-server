import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sanitizeArg } from "../utils/command.js";

/**
 * Tool: run_cypress_test
 *
 * A controlled tool that prepares a Cypress run from typed parameters and
 * returns the command that would be executed. Stub / dry-run for the MVP.
 */
export function registerRunCypressTest(server: McpServer): void {
  server.registerTool(
    "run_cypress_test",
    {
      title: "Run Cypress Test",
      description:
        "Prepare a Cypress test run from safe, typed parameters. Returns the " +
        "exact command that would be executed. Controlled tool — no arbitrary " +
        "shell input.",
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

      const summary = [
        "Prepared Cypress run (dry run — not executed).",
        "",
        `Command: ${command}`,
        "",
        "Parameters:",
        `- spec:    ${safeSpec ?? "(all specs)"}`,
        `- browser: ${safeBrowser ?? "(default browser)"}`,
        "",
        "To execute this for real, run the command above in the project that " +
          "has Cypress installed. Execution is disabled by default in this MVP.",
      ].join("\n");

      return {
        content: [{ type: "text", text: summary }],
      };
    },
  );
}
