import { spawn } from "node:child_process";

/**
 * Safe, controlled command execution utility.
 *
 * This is intentionally NOT a generic terminal. The LLM cannot ask the server
 * to run arbitrary shell commands. Instead, each QA tool builds an argument
 * list for a known, allowlisted binary and passes it through this helper.
 *
 * Design goals (some enforced now, some reserved for later):
 *  - allowlist        : only pre-approved binaries may be executed
 *  - no shell         : arguments are passed as an array, never interpolated
 *                       into a shell string, so injection is not possible
 *  - timeout          : commands are killed if they run too long
 *  - working directory: execution is pinned to an explicit cwd
 *  - output size limit : captured output is truncated to a safe maximum
 */

/**
 * Sanitize a single argument coming from an untrusted caller (e.g. an LLM).
 *
 * Control characters — carriage returns, newlines, tabs, escape sequences —
 * have no place in a test path, project name, or spec glob. Left in, they can
 * silently corrupt a copy-pasted command line (a `\r` makes later text
 * overstrike earlier text on screen) and are a red flag for injection attempts.
 * We strip them and collapse surrounding whitespace.
 */
export function sanitizeArg(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1F\x7F]/g, "").trim();
}

/** Binaries this server is ever allowed to execute. */
export const ALLOWED_COMMANDS = ["npx", "pnpm", "node"] as const;
export type AllowedCommand = (typeof ALLOWED_COMMANDS)[number];

export interface RunCommandOptions {
  /** Binary to run. Must be present in {@link ALLOWED_COMMANDS}. */
  command: AllowedCommand;
  /** Arguments passed directly to the binary (no shell parsing). */
  args: string[];
  /** Working directory. Defaults to the current process cwd. */
  cwd?: string;
  /** Max execution time in milliseconds before the process is killed. */
  timeoutMs?: number;
  /** Max number of captured output characters before truncation. */
  maxOutputChars?: number;
}

export interface RunCommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;

/**
 * Execute an allowlisted command safely and capture its output.
 *
 * Throws if the requested command is not in the allowlist — this is a
 * programming error, not something an LLM should be able to trigger.
 */
export function runCommand(options: RunCommandOptions): Promise<RunCommandResult> {
  const {
    command,
    args,
    cwd = process.cwd(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
  } = options;

  if (!ALLOWED_COMMANDS.includes(command)) {
    return Promise.reject(
      new Error(
        `Refusing to run "${command}": not in the allowlist (${ALLOWED_COMMANDS.join(", ")}).`,
      ),
    );
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;

    const append = (buffer: string, chunk: Buffer): string => {
      if (buffer.length >= maxOutputChars) {
        truncated = true;
        return buffer;
      }
      const next = buffer + chunk.toString("utf8");
      if (next.length > maxOutputChars) {
        truncated = true;
        return next.slice(0, maxOutputChars);
      }
      return next;
    };

    const child = spawn(command, args, {
      cwd,
      // Never run through a shell: arguments cannot be reinterpreted.
      shell: false,
      env: process.env,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        command: `${command} ${args.join(" ")}`.trim(),
        exitCode: null,
        stdout,
        stderr: stderr + `\n[spawn error] ${err.message}`,
        timedOut,
        truncated,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        command: `${command} ${args.join(" ")}`.trim(),
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        truncated,
      });
    });
  });
}
