/**
 * Execution configuration, read from the environment.
 *
 * The server is safe by default: unless execution is explicitly enabled AND a
 * project directory is provided, the run tools stay in dry-run mode and never
 * touch a process. This keeps "connect anywhere" safe and makes real execution
 * an explicit, operator-controlled decision.
 *
 * Environment variables:
 *   QA_MCP_EXECUTION_MODE  "dry-run" (default) | "live"
 *   QA_MCP_PROJECT_DIR     absolute path to the ONLY directory tests may run in
 *   QA_MCP_EXEC_TIMEOUT_MS max run time in ms (default 600000 = 10 min)
 *
 * Config is read on each call rather than cached, so an operator can change the
 * environment without restarting and behaviour stays easy to reason about.
 */

export type ExecutionMode = "dry-run" | "live";

export interface ExecutionConfig {
  mode: ExecutionMode;
  /** Absolute project directory, or undefined if not configured. */
  projectDir: string | undefined;
  timeoutMs: number;
}

const DEFAULT_EXEC_TIMEOUT_MS = 600_000;

export function getExecutionConfig(): ExecutionConfig {
  const rawMode = (process.env.QA_MCP_EXECUTION_MODE ?? "dry-run").trim().toLowerCase();
  const mode: ExecutionMode = rawMode === "live" ? "live" : "dry-run";

  const rawDir = process.env.QA_MCP_PROJECT_DIR?.trim();
  const projectDir = rawDir && rawDir.length > 0 ? rawDir : undefined;

  const rawTimeout = Number(process.env.QA_MCP_EXEC_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_EXEC_TIMEOUT_MS;

  return { mode, projectDir, timeoutMs };
}

/** True only when live execution is fully configured (mode + project dir). */
export function isLiveExecutionEnabled(): boolean {
  const { mode, projectDir } = getExecutionConfig();
  return mode === "live" && Boolean(projectDir);
}
