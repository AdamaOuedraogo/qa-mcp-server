import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { runCommand, type RunCommandResult } from "../utils/command.js";
import { getExecutionConfig } from "../config.js";

/**
 * Execution adapter — the single security boundary for real test runs.
 *
 * Tool handlers never spawn a process directly. They build a validated,
 * sanitized argument list and hand it to this adapter, which:
 *   - refuses to run unless live execution is configured (mode + project dir),
 *   - pins the working directory to the configured project (no escape),
 *   - rejects path-traversal in arguments,
 *   - delegates to the allowlisted, no-shell runCommand helper.
 *
 * Keeping this logic in one place means the security properties are auditable
 * in a single file, exactly as described in docs/architecture.md.
 */

export class ExecutionError extends Error {}

/** Reject arguments that try to climb out of the project directory. */
function assertNoPathTraversal(args: string[]): void {
  for (const arg of args) {
    const segments = arg.split(/[\\/]/);
    if (segments.includes("..")) {
      throw new ExecutionError(
        `Refusing argument "${arg}": path traversal ("..") is not allowed.`,
      );
    }
  }
}

/**
 * Run an allowlisted test command inside the configured project directory.
 *
 * @param args Full argument list for `npx`, e.g. ["cypress", "run", "--spec", "..."].
 */
export async function runInProject(args: string[]): Promise<RunCommandResult> {
  const { mode, projectDir, timeoutMs } = getExecutionConfig();

  if (mode !== "live") {
    throw new ExecutionError(
      "Live execution is not enabled (set QA_MCP_EXECUTION_MODE=live).",
    );
  }
  if (!projectDir) {
    throw new ExecutionError(
      "No project directory configured (set QA_MCP_PROJECT_DIR to an absolute path).",
    );
  }
  if (!isAbsolute(projectDir)) {
    throw new ExecutionError(`QA_MCP_PROJECT_DIR must be an absolute path (got "${projectDir}").`);
  }

  const resolved = resolve(projectDir);
  let isDir = false;
  try {
    isDir = statSync(resolved).isDirectory();
  } catch {
    throw new ExecutionError(`Project directory does not exist: ${resolved}`);
  }
  if (!isDir) {
    throw new ExecutionError(`Project path is not a directory: ${resolved}`);
  }

  assertNoPathTraversal(args);

  // npx resolves the project-local binary (cypress/playwright) from node_modules.
  return runCommand({
    command: "npx",
    args,
    cwd: resolved,
    timeoutMs,
  });
}

/** Render a completed run into a structured, human- and LLM-readable summary. */
export function renderRunResult(
  label: string,
  command: string,
  cwd: string,
  result: RunCommandResult,
): string {
  const status = result.timedOut
    ? "timed out"
    : result.exitCode === 0
      ? "passed"
      : "failed";

  const output = [result.stdout, result.stderr].filter((s) => s.trim().length > 0).join("\n");

  return [
    `${label} run (live) — ${status}.`,
    "",
    `Command: ${command}`,
    `Working directory: ${cwd}`,
    `Exit code: ${result.exitCode ?? "n/a"}`,
    result.timedOut ? "Timed out: yes" : null,
    result.truncated ? "Note: output was truncated." : null,
    "",
    "----- OUTPUT -----",
    output.length > 0 ? output : "(no output captured)",
    "----- END OUTPUT -----",
  ]
    .filter((line) => line !== null)
    .join("\n");
}
