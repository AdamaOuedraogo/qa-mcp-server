import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

/**
 * openConfined(): a bounded read of one file confined to a root directory.
 *
 * Internal only; not exposed over MCP. Extracted from `read_test_report`
 * without behaviour change, so every caller that reads project files gets the
 * same checks.
 *
 * Threat model. The decision to read is bound to the opened file descriptor,
 * not to a pathname that another process could change between a check and
 * the open (TOCTOU):
 *   1. The path is opened first, with O_NOFOLLOW where the platform has it,
 *      so the final path component cannot be a symbolic link.
 *   2. The open descriptor is stat'ed and must be a regular file.
 *   3. Only then is the path resolved with realpath and checked to lie inside
 *      the root; the resolved path is stat'ed and must be the same file
 *      (device and inode) as the open descriptor, or the read is refused.
 *      The read itself uses the descriptor, never the path again.
 * Limitations: on a platform without O_NOFOLLOW (Windows) a symbolic link as
 * the final component is followed and only step 3 protects; a symbolic link
 * in an intermediate directory can still be swapped between the open and the
 * realpath, which step 3 detects by refusing when the identities differ; a
 * hard link inside the root to a file outside it is indistinguishable by
 * inode, so write access to the root remains trusted. None of this is a
 * filesystem sandbox.
 */

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

/** Why a confined read was refused. Callers turn each kind into their own message. */
export type ConfinedRefusal =
  | { kind: "root-unset" }
  | { kind: "root-not-absolute" }
  | { kind: "absolute-path" }
  | { kind: "traversal" }
  | { kind: "root-missing" }
  | { kind: "final-symlink" }
  | { kind: "open-failed"; message: string }
  | { kind: "not-regular-file" }
  | { kind: "resolve-failed"; message: string }
  | { kind: "outside-root" }
  | { kind: "identity-changed" }
  | { kind: "read-failed"; message: string };

export type ConfinedRead =
  | {
      ok: true;
      /** The root after realpath. */
      realRoot: string;
      /** Size of the opened file, from the descriptor. */
      size: number;
      /** At most `maxBytes` bytes from the start of the file. */
      bytes: Buffer;
    }
  | { ok: false; refusal: ConfinedRefusal };

function refused(refusal: ConfinedRefusal): ConfinedRead {
  return { ok: false, refusal };
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read at most `maxBytes` bytes of `rel`, a path relative to `root`.
 *
 * @param root      Absolute root directory, normally `QA_MCP_PROJECT_DIR`.
 *                  Undefined or empty is refused.
 * @param rel       Path relative to `root`. Absolute paths and `..` segments
 *                  are refused; callers sanitize it first.
 * @param maxBytes  Upper bound on bytes read from disk.
 */
export async function openConfined(
  root: string | undefined,
  rel: string,
  maxBytes: number,
): Promise<ConfinedRead> {
  if (!root) return refused({ kind: "root-unset" });
  if (!isAbsolute(root)) return refused({ kind: "root-not-absolute" });
  if (isAbsolute(rel) || WINDOWS_ABSOLUTE.test(rel) || rel.startsWith("\\")) {
    return refused({ kind: "absolute-path" });
  }
  if (rel.split(/[\\/]/).includes("..")) return refused({ kind: "traversal" });

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return refused({ kind: "root-missing" });
  }
  const candidate = resolve(realRoot, rel);

  // Step 1: open first. With O_NOFOLLOW a symlink as the final component fails.
  let handle: FileHandle;
  try {
    handle = await open(candidate, OPEN_FLAGS);
  } catch (err) {
    if (errorCode(err) === "ELOOP") return refused({ kind: "final-symlink" });
    return refused({ kind: "open-failed", message: messageOf(err) });
  }

  try {
    // Step 2: the open descriptor must be a regular file.
    const opened = await handle.stat();
    if (!opened.isFile()) return refused({ kind: "not-regular-file" });

    // Step 3: containment on the resolved path, then bind it to the descriptor.
    let realTarget: string;
    try {
      realTarget = await realpath(candidate);
    } catch (err) {
      return refused({ kind: "resolve-failed", message: messageOf(err) });
    }
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      return refused({ kind: "outside-root" });
    }
    const resolved = await stat(realTarget);
    if (!sameFile(opened, resolved)) return refused({ kind: "identity-changed" });

    // Step 4: bounded read, from the descriptor that passed the checks.
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return { ok: true, realRoot, size: opened.size, bytes: buffer.subarray(0, bytesRead) };
  } catch (err) {
    return refused({ kind: "read-failed", message: messageOf(err) });
  } finally {
    await handle.close();
  }
}
