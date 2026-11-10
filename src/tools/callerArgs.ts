import { isAbsolute } from "node:path";
import { sanitizeArg } from "../utils/command.js";

/**
 * Validation of free-form caller values that end up in a test runner's argv.
 *
 * Tool inputs come from an LLM and are untrusted. The run tools accept a few
 * free-form strings (a spec path, a project or browser name) that are placed
 * as discrete argv entries after a fixed prefix such as `playwright test`.
 * Because there is no shell, such a value can never add a command. It could
 * still be read by the runner itself as an option (`--config=evil.js`) or
 * point outside the project directory (an absolute path, or `..`). Both are
 * refused here, before the value reaches the execution adapter.
 */

export class CallerArgError extends Error {}

/** `C:\...` or `C:/...` on any platform, so a Windows path is never accepted. */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/**
 * Sanitize a caller-supplied value and refuse shapes that could change what
 * the runner does. Returns the sanitized value; an empty string after
 * sanitization is returned as is so callers can treat it as "not provided".
 */
export function callerArg(value: string, label: string): string {
  const safe = sanitizeArg(value);
  if (safe.length === 0) return safe;
  if (safe.startsWith("-")) {
    throw new CallerArgError(
      `Refusing ${label} "${safe}": values starting with "-" are not accepted (options are not caller input).`,
    );
  }
  if (isAbsolute(safe) || WINDOWS_ABSOLUTE.test(safe) || safe.startsWith("\\")) {
    throw new CallerArgError(
      `Refusing ${label} "${safe}": absolute paths are not accepted; use a path relative to the project directory.`,
    );
  }
  if (safe.split(/[\\/]/).includes("..")) {
    throw new CallerArgError(
      `Refusing ${label} "${safe}": path traversal ("..") is not allowed.`,
    );
  }
  return safe;
}
