import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sanitizeArg } from "../utils/command.js";
import { getExecutionConfig, isLiveExecutionEnabled } from "../config.js";
import { ExecutionError, renderRunResult, runInProject } from "../execution/adapter.js";
import { TARGET_ENVIRONMENTS, resolveEnvironment } from "../environments.js";

/**
 * Tool: run_cypress_test
 *
 * A controlled tool that runs Cypress from typed parameters. By default it is a
 * dry run (returns the command it would execute). When live execution is
 * enabled, it runs Cypress inside the configured project directory through the
 * execution adapter (the single security boundary).
 *
 * The optional `environment` is a closed enum. It is mapped to project-specific
 * configuration the operator provides (a base URL), which is injected as the
 * CYPRESS_BASE_URL env var — never string-interpolated into the command. The
 * environment name is also passed as `--env target=<name>` so the project can
 * branch on it. The caller can select an environment but can never define what
 * it points to.
 */
export function registerRunCypressTest(server: McpServer): void {
  server.registerTool(
    "run_cypress_test",
    {
      title: "Run Cypress Test",
      description:
        "Run a Cypress test from safe, typed parameters. Dry-run by default " +
        "(returns the exact command); executes for real only when live " +
        "execution is enabled. An optional target environment maps to " +
        "operator-configured settings. Controlled tool — no arbitrary shell input.",
      inputSchema: {
        spec: z
          .string()
          .optional()
          .describe("Glob or path to a spec file, e.g. cypress/e2e/login.cy.ts"),
        browser: z
          .string()
          .optional()
          .describe("Browser to run in, e.g. chrome, firefox, electron."),
        environment: z
          .enum(TARGET_ENVIRONMENTS)
          .optional()
          .describe(
            "Target environment. Mapped to operator-configured settings " +
              "(base URL via QA_MCP_BASE_URL_<ENV>); passed as --env target=<env>.",
          ),
      },
    },
    async ({ spec, browser, environment }) => {
      const safeSpec = spec ? sanitizeArg(spec) : undefined;
      const safeBrowser = browser ? sanitizeArg(browser) : undefined;

      const args = ["cypress", "run"];
      if (safeSpec) args.push("--spec", safeSpec);
      if (safeBrowser) args.push("--browser", safeBrowser);

      // Resolve the closed environment name to operator-provided config.
      const resolved = environment ? resolveEnvironment(environment) : undefined;
      const extraEnv: Record<string, string> = {};
      if (resolved) {
        // `target` value comes from the fixed enum, so it is always safe.
        args.push("--env", `target=${resolved.name}`);
        if (resolved.baseUrl) extraEnv.CYPRESS_BASE_URL = resolved.baseUrl;
      }

      const command = `npx ${args.join(" ")}`;

      const envLines = resolved
        ? [
            `- environment: ${resolved.name}`,
            `- base URL:    ${resolved.baseUrl ?? "(not configured — using project defaults)"}`,
          ]
        : ["- environment: (project default)"];

      // Dry-run (default): describe the command without executing anything.
      if (!isLiveExecutionEnabled()) {
        const summary = [
          "Prepared Cypress run (dry run — not executed).",
          "",
          `Command: ${command}`,
          resolved?.baseUrl ? `Env:     CYPRESS_BASE_URL=${resolved.baseUrl}` : null,
          "",
          "Parameters:",
          `- spec:    ${safeSpec ?? "(all specs)"}`,
          `- browser: ${safeBrowser ?? "(default browser)"}`,
          ...envLines,
          "",
          "Live execution is disabled. To enable it, set QA_MCP_EXECUTION_MODE=live " +
            "and QA_MCP_PROJECT_DIR to the absolute path of a Cypress project.",
        ]
          .filter((line) => line !== null)
          .join("\n");

        return { content: [{ type: "text", text: summary }] };
      }

      // Live: run through the execution adapter (security boundary).
      const { projectDir } = getExecutionConfig();
      try {
        const result = await runInProject(args, extraEnv);
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
