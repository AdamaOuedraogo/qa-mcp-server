/**
 * Per-runner operator configuration.
 *
 * By default the run tools expose a *fixed, safe* command shape
 * (`cypress run`, `playwright test`). Real projects differ, though: a Cypress
 * project may keep its config in a non-default file, require the `--e2e` testing
 * type, or read project-specific environment variables (PROJECT, ENVIRONMENT…).
 * A Playwright project may use a non-default config file.
 *
 * To let the server plug into ANY project without ever accepting free-form input
 * from the model, these project-specific details are provided by the OPERATOR
 * through environment variables — exactly like base URLs in `environments.ts`.
 * The caller (an LLM) still only chooses from typed parameters and closed enums;
 * the operator decides, once, how their project must be invoked.
 *
 * Because commands run with `shell: false` (see utils/command.ts), these values
 * are passed as discrete argv entries or as child env — never interpolated into
 * a shell string — so they cannot inject additional commands. Path traversal in
 * argv (e.g. a config path containing "..") is still rejected by the execution
 * adapter.
 *
 * Cypress:
 *   QA_MCP_CYPRESS_CONFIG_FILE   → --config-file <path>
 *   QA_MCP_CYPRESS_E2E           → add --e2e when truthy
 *   QA_MCP_CYPRESS_PROJECT       → injected as the PROJECT env var
 *   QA_MCP_CYPRESS_ENV_VAR       → name of an env var that receives the selected
 *                                  environment name (e.g. "ENVIRONMENT")
 *
 * Playwright:
 *   QA_MCP_PLAYWRIGHT_CONFIG_FILE → --config <path>
 */

/** Read a non-empty, trimmed string env var, or undefined. */
function readString(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

/** Read a boolean-ish env var. Truthy values: 1, true, yes, on (case-insensitive). */
function readFlag(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export interface CypressRunnerConfig {
  /** Path to a non-default Cypress config file, passed as `--config-file`. */
  configFile?: string;
  /** Whether to add `--e2e` (required by some Cucumber/hybrid setups). */
  e2e: boolean;
  /** Value injected as the `PROJECT` env var, if the project reads it. */
  project?: string;
  /**
   * Name of an env var that should receive the selected environment name.
   * E.g. set to "ENVIRONMENT" so a project that resolves its config from
   * `ENVIRONMENT` picks up the caller's chosen environment.
   */
  environmentVar?: string;
}

/** Resolve operator-provided Cypress invocation details from the environment. */
export function getCypressRunnerConfig(): CypressRunnerConfig {
  return {
    configFile: readString("QA_MCP_CYPRESS_CONFIG_FILE"),
    e2e: readFlag("QA_MCP_CYPRESS_E2E"),
    project: readString("QA_MCP_CYPRESS_PROJECT"),
    environmentVar: readString("QA_MCP_CYPRESS_ENV_VAR"),
  };
}

export interface PlaywrightRunnerConfig {
  /** Path to a non-default Playwright config file, passed as `--config`. */
  configFile?: string;
}

/** Resolve operator-provided Playwright invocation details from the environment. */
export function getPlaywrightRunnerConfig(): PlaywrightRunnerConfig {
  return {
    configFile: readString("QA_MCP_PLAYWRIGHT_CONFIG_FILE"),
  };
}
