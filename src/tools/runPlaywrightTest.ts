import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sanitizeArg } from "../utils/command.js";
import { getExecutionConfig, isLiveExecutionEnabled } from "../config.js";
import { ExecutionError, renderRunResult, runInProject } from "../execution/adapter.js";
import { TARGET_ENVIRONMENTS, resolveEnvironment } from "../environments.js";
import { getPlaywrightRunnerConfig } from "../runners.js";

/**
 * Tool: run_playwright_test
 *
 * A *controlled* tool (not a generic terminal). By default it is a dry run
 * (returns the exact Playwright command). When live execution is enabled, it
 * runs Playwright inside the configured project directory through the execution
 * adapter (the single security boundary).
 *
 * The optional `environment` is a closed enum mapped to operator-provided
 * configuration (a base URL), injected as the PLAYWRIGHT_BASE_URL env var —
 * never string-interpolated into the command. Playwright has no generic `--env`
 * flag, so base-URL injection is the standard mechanism. The caller can select
 * an environment but can never define what it points to.
 */
export function registerRunPlaywrightTest(server: McpServer): void {
  server.registerTool(
    "run_playwright_test",
    {
      title: "Run Playwright Test",
      description:
        "Run a Playwright test from safe, typed parameters. Dry-run by default " +
        "(returns the exact command); executes for real only when live " +
        "execution is enabled. An optional target environment maps to " +
        "operator-configured settings. Controlled tool — no arbitrary shell input.",
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
        environment: z
          .enum(TARGET_ENVIRONMENTS)
          .optional()
          .describe(
            "Target environment. Mapped to operator-configured settings " +
              "(base URL via QA_MCP_BASE_URL_<ENV>), injected as PLAYWRIGHT_BASE_URL.",
          ),
      },
    },
    async ({ testPath, headed, project, environment }) => {
      // Strip control characters from caller-supplied values before they land
      // in a command string a human may copy-paste (see sanitizeArg).
      const safeTestPath = testPath ? sanitizeArg(testPath) : undefined;
      const safeProject = project ? sanitizeArg(project) : undefined;

      const args = ["playwright", "test"];
      if (safeTestPath) args.push(safeTestPath);
      if (safeProject) args.push("--project", safeProject);
      if (headed) args.push("--headed");

      // Operator-provided config file for non-default Playwright setups.
      const runner = getPlaywrightRunnerConfig();
      if (runner.configFile) args.push("--config", sanitizeArg(runner.configFile));

      // Resolve the closed environment name to operator-provided config.
      const resolved = environment ? resolveEnvironment(environment) : undefined;
      const extraEnv: Record<string, string> = {};
      if (resolved?.baseUrl) extraEnv.PLAYWRIGHT_BASE_URL = resolved.baseUrl;

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
          "Prepared Playwright run (dry run — not executed).",
          "",
          `Command: ${command}`,
          resolved?.baseUrl ? `Env:     PLAYWRIGHT_BASE_URL=${resolved.baseUrl}` : null,
          "",
          "Parameters:",
          `- testPath:    ${safeTestPath ?? "(all tests)"}`,
          `- project:     ${safeProject ?? "(default projects)"}`,
          `- headed:      ${headed ? "yes" : "no"}`,
          `- config file: ${runner.configFile ?? "(default)"}`,
          ...envLines,
          "",
          "Live execution is disabled. To enable it, set QA_MCP_EXECUTION_MODE=live " +
            "and QA_MCP_PROJECT_DIR to the absolute path of a Playwright project.",
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
