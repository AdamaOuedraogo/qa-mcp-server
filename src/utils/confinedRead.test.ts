import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HAS_O_NOFOLLOW, openConfined } from "./confinedRead.js";

let base: string;
let root: string;

before(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "qa-confined-")));
  root = join(base, "root");
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "sub", "a.txt"), "0123456789");
  await writeFile(join(base, "outside.txt"), "secret");
  await symlink(join(base, "outside.txt"), join(root, "link.txt"));
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

function kind(r: Awaited<ReturnType<typeof openConfined>>): string {
  return r.ok ? "ok" : r.refusal.kind;
}

test("openConfined returns the bytes, the real root and the size", async () => {
  const r = await openConfined(root, "sub/a.txt", 100);
  assert.ok(r.ok);
  assert.equal(r.bytes.toString("utf8"), "0123456789");
  assert.equal(r.size, 10);
  assert.equal(r.realRoot, root);
});

test("openConfined reads at most maxBytes and still reports the full size", async () => {
  const r = await openConfined(root, "sub/a.txt", 4);
  assert.ok(r.ok);
  assert.equal(r.bytes.toString("utf8"), "0123");
  assert.equal(r.size, 10);
});

test("openConfined refuses an unset, relative or missing root", async () => {
  assert.equal(kind(await openConfined(undefined, "sub/a.txt", 10)), "root-unset");
  assert.equal(kind(await openConfined("", "sub/a.txt", 10)), "root-unset");
  assert.equal(kind(await openConfined("relative/dir", "sub/a.txt", 10)), "root-not-absolute");
  assert.equal(kind(await openConfined(join(base, "nope"), "a.txt", 10)), "root-missing");
});

test("openConfined refuses absolute paths and '..' before touching the disk", async () => {
  assert.equal(kind(await openConfined(root, join(base, "outside.txt"), 10)), "absolute-path");
  assert.equal(kind(await openConfined(root, "C:/x.txt", 10)), "absolute-path");
  assert.equal(kind(await openConfined(root, "sub/../../outside.txt", 10)), "traversal");
});

test("openConfined refuses a directory and a missing file", async () => {
  assert.equal(kind(await openConfined(root, "sub", 10)), "not-regular-file");
  assert.equal(kind(await openConfined(root, "sub/none.txt", 10)), "open-failed");
});

test("openConfined refuses a symbolic link as the final component", async () => {
  const expected = HAS_O_NOFOLLOW ? "final-symlink" : "outside-root";
  assert.equal(kind(await openConfined(root, "link.txt", 10)), expected);
});
