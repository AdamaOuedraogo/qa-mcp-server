import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getExecutionConfig } from "../config.js";
import { sanitizeArg } from "../utils/command.js";
import { wrapUntrusted } from "../utils/untrusted.js";
import { openConfined, type ConfinedRefusal } from "../utils/confinedRead.js";

export { HAS_O_NOFOLLOW, OPEN_FLAGS, sameFile, type FileIdentity } from "../utils/confinedRead.js";

/**
 * Tool: read_test_report
 *
 * Reads a test report file (JSON, XML, or text) from inside the configured
 * project directory and returns at most {@link MAX_REPORT_BYTES} bytes of it,
 * labelled as untrusted data. It does not execute anything.
 *
 * The checks (open with O_NOFOLLOW, regular file, realpath containment,
 * device/inode match, bounded read from the descriptor) live in
 * {@link openConfined}; its comment states the threat model and limitations.
 * None of this is a filesystem sandbox.
 */

/** Maximum number of bytes read from disk. The rest of the file is never read. */
export const MAX_REPORT_BYTES = 20_000;
export const DEFAULT_REPORT_PATH = "playwright-report/results.json";

export interface ReadReportResult {
  text: string;
  isError: boolean;
}

function failure(text: string): ReadReportResult {
  return { text, isError: true };
}

/**
 * Read a report file from inside the configured project directory.
 *
 * @param reportPath  Caller-supplied path, relative to the project directory.
 * @param projectDir  Project directory; defaults to the operator configuration.
 */
export async function readReport(
  reportPath: string | undefined,
  projectDir: string | undefined = getExecutionConfig().projectDir,
): Promise<ReadReportResult> {
  const sanitized = reportPath ? sanitizeArg(reportPath) : "";
  const target = sanitized.length > 0 ? sanitized : DEFAULT_REPORT_PATH;

  const read = await openConfined(projectDir, target, MAX_REPORT_BYTES);
  if (!read.ok) return failure(refusalText(read.refusal, target, projectDir));

  const { realRoot, size, bytes } = read;
  const bytesRead = bytes.length;
  const bounded = size > bytesRead;
  const body = bytes.toString("utf8");

  const sizeLine = bounded
    ? `Size: ${size} bytes; only the first ${bytesRead} bytes were read from disk ` +
      `(bounded read, limit ${MAX_REPORT_BYTES} bytes). The rest was not read.`
    : `Size: ${size} bytes (read in full).`;

  const text = [
    `Report: ${target} (relative to the project directory)`,
    `Project directory: ${realRoot}`,
    sizeLine,
    "",
    wrapUntrusted(`the test report ${target}`, body),
  ].join("\n");

  return { text, isError: false };
}

/** The read_test_report wording for each refusal of {@link openConfined}. */
function refusalText(r: ConfinedRefusal, target: string, projectDir: string | undefined): string {
  switch (r.kind) {
    case "root-unset":
      return (
        "read_test_report needs QA_MCP_PROJECT_DIR: it reads only inside that " +
        "directory. Set it to the absolute path of the project that holds the report."
      );
    case "root-not-absolute":
      return `QA_MCP_PROJECT_DIR must be an absolute path (got "${projectDir}").`;
    case "absolute-path":
      return (
        `Refusing "${target}": absolute paths are not accepted. ` +
        "Give a path relative to the project directory."
      );
    case "traversal":
      return `Refusing "${target}": path traversal ("..") is not allowed.`;
    case "root-missing":
      return `Project directory does not exist: ${projectDir}`;
    case "final-symlink":
      return (
        `Refusing "${target}": the final path component is a symbolic link; ` +
        "give the path of the file itself."
      );
    case "open-failed":
      return (
        `Could not read report at "${target}" (relative to the project directory).\n` +
        `Reason: ${r.message}\n\n` +
        "Provide a valid reportPath, or run your tests with a file reporter " +
        "first (e.g. Playwright's json reporter)."
      );
    case "not-regular-file":
      return `Refusing "${target}": it is not a regular file.`;
    case "resolve-failed":
      return `Could not resolve report at "${target}".\nReason: ${r.message}`;
    case "outside-root":
      return (
        `Refusing "${target}": it resolves outside the project directory ` +
        "(symbolic links are followed before this check)."
      );
    case "identity-changed":
      return (
        `Refusing "${target}": the file changed between the containment check ` +
        "and the open (the opened descriptor and the resolved path are not the same file)."
      );
    case "read-failed":
      return `Could not read report at "${target}".\nReason: ${r.message}`;
  }
}

export function registerReadTestReport(server: McpServer): void {
  server.registerTool(
    "read_test_report",
    {
      title: "Read Test Report",
      description:
        "Read a test report artifact (e.g. Playwright JSON reporter output, " +
        "JUnit XML, or a text summary) from inside the configured project " +
        "directory and return its first 20,000 bytes, labelled as untrusted data. " +
        "Requires QA_MCP_PROJECT_DIR; the path must be relative to it and must " +
        "name the file itself, not a symbolic link.",
      inputSchema: {
        reportPath: z
          .string()
          .optional()
          .describe(
            "Path to the report file, relative to QA_MCP_PROJECT_DIR, e.g. " +
              "playwright-report/results.json (the default). Absolute paths, " +
              '".." and symbolic links as the final component are refused.',
          ),
      },
    },
    async ({ reportPath }) => {
      const result = await readReport(reportPath);
      return result.isError
        ? { isError: true, content: [{ type: "text", text: result.text }] }
        : { content: [{ type: "text", text: result.text }] };
    },
  );
}
