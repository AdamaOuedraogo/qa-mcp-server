import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED_COMMANDS, runCommand, sanitizeArg, type AllowedCommand } from "./command.js";

/**
 * Tests for the single process-spawning helper. The ones that spawn use
 * `node` with inline scripts; that is test code exercising the helper, not a
 * path any tool exposes (see runTools.test.ts for that guarantee).
 */

test("sanitizeArg strips control characters and trims", () => {
  assert.equal(sanitizeArg("tests/login.spec.ts\r\n"), "tests/login.spec.ts");
  assert.equal(sanitizeArg("\x1b[31mred\x1b[0m"), "[31mred[0m");
  assert.equal(sanitizeArg("  a\tb  "), "ab");
  assert.equal(sanitizeArg("\x00\x7f"), "");
});

test("the allowlist is exactly npx, pnpm and node", () => {
  assert.deepEqual([...ALLOWED_COMMANDS], ["npx", "pnpm", "node"]);
});

test("a command outside the allowlist is rejected without spawning", async () => {
  for (const command of ["bash", "sh", "/bin/sh", "npx ", "NODE", ""]) {
    await assert.rejects(
      runCommand({ command: command as AllowedCommand, args: ["-c", "echo hi"] }),
      /not in the allowlist/,
    );
  }
});

test("arguments are passed as-is: no shell interprets metacharacters", async () => {
  const result = await runCommand({
    command: "node",
    args: ["-p", "process.argv.slice(1).join('|')", "a;b", "$(id)", "`id`", "a && b", "*"],
    timeoutMs: 20_000,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.trim(), "a;b|$(id)|`id`|a && b|*");
});

test("the working directory is pinned to the given cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qa-mcp-cwd-"));
  try {
    const result = await runCommand({ command: "node", args: ["-p", "process.cwd()"], cwd: dir, timeoutMs: 20_000 });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(await realpath(result.stdout.trim()), await realpath(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extra env reaches the child as env, not as arguments", async () => {
  const result = await runCommand({
    command: "node",
    args: ["-p", "process.env.QA_MCP_TEST_PROBE + ':' + process.argv.length"],
    env: { QA_MCP_TEST_PROBE: "probe-value" },
    timeoutMs: 20_000,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.trim(), "probe-value:1");
});

test("a run that exceeds the timeout is killed and reported as timedOut", async () => {
  const started = Date.now();
  const result = await runCommand({
    command: "node",
    args: ["-e", "setTimeout(() => {}, 30000)"],
    timeoutMs: 300,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null, "a killed process has no exit code");
  assert.ok(Date.now() - started < 10_000, "the process did not run to its 30 s sleep");
});

test("captured output is capped and flagged as truncated", async () => {
  const result = await runCommand({
    command: "node",
    args: ["-e", "process.stdout.write('x'.repeat(60000))"],
    maxOutputChars: 1000,
    timeoutMs: 20_000,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.truncated, true);
  assert.equal(result.stdout.length, 1000);
});

test("output under the cap is not flagged", async () => {
  const result = await runCommand({ command: "node", args: ["-p", "'ok'"], timeoutMs: 20_000 });
  assert.equal(result.truncated, false);
  assert.equal(result.stdout.trim(), "ok");
});

test("a spawn failure is reported, not thrown", async () => {
  // `node` with a cwd that does not exist cannot be spawned.
  const result = await runCommand({ command: "node", args: ["-p", "1"], cwd: "/absolute/path/that/does/not/exist" });
  assert.equal(result.exitCode, null);
  assert.match(result.stderr, /\[spawn error\]/);
});
