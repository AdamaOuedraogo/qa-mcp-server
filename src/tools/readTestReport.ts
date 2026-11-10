import { z } from "zod";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getExecutionConfig } from "../config.js";
import { sanitizeArg } from "../utils/command.js";
import { wrapUntrusted } from "../utils/untrusted.js";

/** Maximum number of bytes read from disk. The rest of the file is never read. */
export const MAX_REPORT_BYTES = 20_000;
export const DEFAULT_REPORT_PATH = "playwright-report/results.json";

/** `C:\...` or `C:/...` on any platform. */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

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
 * Confinement, in order:
 *   1. `QA_MCP_PROJECT_DIR` must be set to an absolute path; without it the
 *      tool refuses rather than guessing a directory.
 *   2. The caller path must be relative, and must not contain `..`.
 *   3. Both the project directory and the target are resolved with realpath,
 *      so a symbolic link that points outside the project is refused.
 *   4. At most {@link MAX_REPORT_BYTES} bytes are read from disk (a bounded
 *      read, not a full read followed by truncation).
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

  if (!projectDir) {
    return failure(
      "read_test_report needs QA_MCP_PROJECT_DIR: it reads only inside that " +
        "directory. Set it to the absolute path of the project that holds the report.",
    );
  }
  if (!isAbsolute(projectDir)) {
    return failure(`QA_MCP_PROJECT_DIR must be an absolute path (got "${projectDir}").`);
  }
  if (isAbsolute(target) || WINDOWS_ABSOLUTE.test(target) || target.startsWith("\\")) {
    return failure(
      `Refusing "${target}": absolute paths are not accepted. ` +
        "Give a path relative to the project directory.",
    );
  }
  if (target.split(/[\\/]/).includes("..")) {
    return failure(`Refusing "${target}": path traversal ("..") is not allowed.`);
  }

  let realRoot: string;
  try {
    realRoot = await realpath(projectDir);
  } catch {
    return failure(`Project directory does not exist: ${projectDir}`);
  }

  let realTarget: string;
  try {
    realTarget = await realpath(resolve(realRoot, target));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failure(
      `Could not read report at "${target}" (relative to the project directory).\n` +
        `Reason: ${message}\n\n` +
        "Provide a valid reportPath, or run your tests with a file reporter " +
        "first (e.g. Playwright's json reporter).",
    );
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    return failure(
      `Refusing "${target}": it resolves outside the project directory ` +
        "(symbolic links are followed before this check).",
    );
  }

  const handle = await open(realTarget, "r");
  try {
    const stat = await handle.stat();
    if (stat.isDirectory()) {
      return failure(`Refusing "${target}": it is a directory, not a report file.`);
    }
    const buffer = Buffer.alloc(MAX_REPORT_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_REPORT_BYTES, 0);
    const bounded = stat.size > bytesRead;
    const body = buffer.toString("utf8", 0, bytesRead);

    const sizeLine = bounded
      ? `Size: ${stat.size} bytes; only the first ${bytesRead} bytes were read from disk ` +
        `(bounded read, limit ${MAX_REPORT_BYTES} bytes). The rest was not read.`
      : `Size: ${stat.size} bytes (read in full).`;

    const text = [
      `Report: ${target} (relative to the project directory)`,
      `Project directory: ${realRoot}`,
      sizeLine,
      "",
      wrapUntrusted(`the test report ${target}`, body),
    ].join("\n");

    return { text, isError: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failure(`Could not read report at "${target}".\nReason: ${message}`);
  } finally {
    await handle.close();
  }
}

/**
 * Tool: read_test_report
 *
 * Reads a test report file (JSON, XML, or text) from inside the configured
 * project directory and returns at most {@link MAX_REPORT_BYTES} bytes of it,
 * wrapped as untrusted data. It does not execute anything.
 */
export function registerReadTestReport(server: McpServer): void {
  server.registerTool(
    "read_test_report",
    {
      title: "Read Test Report",
      description:
        "Read a test report artifact (e.g. Playwright JSON reporter output, " +
        "JUnit XML, or a text summary) from inside the configured project " +
        "directory and return its first 20,000 bytes as untrusted data. " +
        "Requires QA_MCP_PROJECT_DIR; the path must be relative to it.",
      inputSchema: {
        reportPath: z
          .string()
          .optional()
          .describe(
            "Path to the report file, relative to QA_MCP_PROJECT_DIR, e.g. " +
              "playwright-report/results.json (the default). Absolute paths " +
              'and ".." are refused.',
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
