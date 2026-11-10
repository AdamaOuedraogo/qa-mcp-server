import { z } from "zod";
import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getExecutionConfig } from "../config.js";
import { sanitizeArg } from "../utils/command.js";
import { wrapUntrusted } from "../utils/untrusted.js";

/**
 * Tool: read_test_report
 *
 * Reads a test report file (JSON, XML, or text) from inside the configured
 * project directory and returns at most {@link MAX_REPORT_BYTES} bytes of it,
 * labelled as untrusted data. It does not execute anything.
 *
 * Threat model. The decision to read is bound to the opened file descriptor,
 * not to a pathname that another process could change between a check and
 * the open (TOCTOU):
 *   1. The path is opened first, with O_NOFOLLOW where the platform has it,
 *      so the final path component cannot be a symbolic link.
 *   2. The open descriptor is stat'ed and must be a regular file.
 *   3. Only then is the path resolved with realpath and checked to lie inside
 *      the project directory; the resolved path is stat'ed and must be the
 *      same file (device and inode) as the open descriptor, or the read is
 *      refused. The read itself uses the descriptor, never the path again.
 * Limitations: on a platform without O_NOFOLLOW (Windows) a symbolic link as
 * the final component is followed and only step 3 protects; a symbolic link
 * in an intermediate directory can still be swapped between the open and the
 * realpath, which step 3 detects by refusing when the identities differ; a
 * hard link inside the project to a file outside it is indistinguishable by
 * inode, so write access to the project directory remains trusted. None of
 * this is a filesystem sandbox.
 */

/** Maximum number of bytes read from disk. The rest of the file is never read. */
export const MAX_REPORT_BYTES = 20_000;
export const DEFAULT_REPORT_PATH = "playwright-report/results.json";

/** `C:\...` or `C:/...` on any platform. */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/** O_NOFOLLOW is undefined on Windows; opening then falls back to step 3 only. */
export const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
export const HAS_O_NOFOLLOW = constants.O_NOFOLLOW !== undefined;

export interface FileIdentity {
  dev: number | bigint;
  ino: number | bigint;
}

/** True when two stat results name the same file: same device and inode. */
export function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

export interface ReadReportResult {
  text: string;
  isError: boolean;
}

function failure(text: string): ReadReportResult {
  return { text, isError: true };
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
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
  const candidate = resolve(realRoot, target);

  // Step 1: open first. With O_NOFOLLOW a symlink as the final component fails.
  let handle: FileHandle;
  try {
    handle = await open(candidate, OPEN_FLAGS);
  } catch (err) {
    if (errorCode(err) === "ELOOP") {
      return failure(
        `Refusing "${target}": the final path component is a symbolic link; ` +
          "give the path of the file itself.",
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return failure(
      `Could not read report at "${target}" (relative to the project directory).\n` +
        `Reason: ${message}\n\n` +
        "Provide a valid reportPath, or run your tests with a file reporter " +
        "first (e.g. Playwright's json reporter).",
    );
  }

  try {
    // Step 2: the open descriptor must be a regular file.
    const opened = await handle.stat();
    if (!opened.isFile()) {
      return failure(`Refusing "${target}": it is not a regular file.`);
    }

    // Step 3: containment on the resolved path, then bind it to the descriptor.
    let realTarget: string;
    try {
      realTarget = await realpath(candidate);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failure(`Could not resolve report at "${target}".\nReason: ${message}`);
    }
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      return failure(
        `Refusing "${target}": it resolves outside the project directory ` +
          "(symbolic links are followed before this check).",
      );
    }
    const resolved = await stat(realTarget);
    if (!sameFile(opened, resolved)) {
      return failure(
        `Refusing "${target}": the file changed between the containment check ` +
          "and the open (the opened descriptor and the resolved path are not the same file).",
      );
    }

    // Step 4: bounded read, from the descriptor that passed the checks.
    const buffer = Buffer.alloc(MAX_REPORT_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_REPORT_BYTES, 0);
    const bounded = opened.size > bytesRead;
    const body = buffer.toString("utf8", 0, bytesRead);

    const sizeLine = bounded
      ? `Size: ${opened.size} bytes; only the first ${bytesRead} bytes were read from disk ` +
        `(bounded read, limit ${MAX_REPORT_BYTES} bytes). The rest was not read.`
      : `Size: ${opened.size} bytes (read in full).`;

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
