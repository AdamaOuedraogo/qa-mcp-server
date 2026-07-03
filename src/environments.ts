/**
 * Target environment resolution.
 *
 * A tool caller (an LLM) may only choose from a fixed, closed set of environment
 * names — never a free-form value. Each name is then mapped to *project-specific*
 * configuration that the operator provides through environment variables. The
 * model can pick "staging"; it can never decide what URL "staging" points to.
 *
 * Operator configuration (all optional):
 *   QA_MCP_BASE_URL_LOCAL
 *   QA_MCP_BASE_URL_STAGING
 *   QA_MCP_BASE_URL_PREPROD
 *   QA_MCP_BASE_URL_PRODUCTION
 *
 * If a base URL is not configured for the requested environment, the tool falls
 * back to the project's own defaults rather than injecting a guessed value.
 */

export const TARGET_ENVIRONMENTS = ["local", "staging", "preprod", "production"] as const;
export type TargetEnvironment = (typeof TARGET_ENVIRONMENTS)[number];

export interface ResolvedEnvironment {
  name: TargetEnvironment;
  /** Operator-configured base URL for this environment, if any. */
  baseUrl: string | undefined;
}

/**
 * Resolve a closed environment name to operator-provided configuration.
 *
 * The name is trusted (validated against the enum upstream by zod). The base URL
 * is read from a per-environment variable, so its value comes from the operator,
 * not from the caller.
 */
export function resolveEnvironment(name: TargetEnvironment): ResolvedEnvironment {
  const key = `QA_MCP_BASE_URL_${name.toUpperCase()}`;
  const raw = process.env[key];
  const baseUrl = raw && raw.trim().length > 0 ? raw.trim() : undefined;
  return { name, baseUrl };
}
