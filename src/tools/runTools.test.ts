import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlaywrightArgs } from "./runPlaywrightTest.js";
import { buildCypressArgs } from "./runCypressTest.js";
import { CallerArgError, callerArg } from "./callerArgs.js";
import { ALLOWED_COMMANDS } from "../utils/command.js";

/**
 * These tests pin the argv shape of the two run tools without spawning
 * anything. The property they protect: no caller value can change which
 * binary, package or subcommand runs, and no caller value can reach `node -e`
 * or `pnpm exec` through a registered tool. Only `npx` is ever spawned by the
 * adapter (see adapter.ts), and the first two argv entries are fixed here.
 */

const noRunnerCypress = { e2e: false } as const;
const noRunnerPlaywright = {} as const;

/** Strings an attacker might try. Each must be refused or stay a single, inert argv entry. */
const HOSTILE = [
  'node -e "require(\'child_process\').execSync(\'id\')"',
  "pnpm exec node -e 1",
  "-e",
  "--config=/tmp/evil.config.ts",
  "--reporter=/tmp/evil-reporter.js",
  "-- node -e 1",
  "/etc/passwd",
  "C:\\Windows\\system32",
  "../../outside/spec.ts",
  "tests/..\\..\\evil.spec.ts",
  "a; rm -rf /",
  "$(id)",
  "`id`",
  "a && node -e 1",
  "a | sh",
  "spec.ts\n--config=/tmp/evil.js",
];

test("playwright argv always starts with the fixed package and subcommand", () => {
  const { args } = buildPlaywrightArgs({}, noRunnerPlaywright, undefined);
  assert.deepEqual(args, ["playwright", "test"]);

  const full = buildPlaywrightArgs(
    { testPath: "tests/login.spec.ts", project: "chromium", headed: true },
    { configFile: "configs/pw.config.ts" },
    { name: "staging", baseUrl: "https://staging.example.com" },
  );
  assert.deepEqual(full.args, [
    "playwright",
    "test",
    "tests/login.spec.ts",
    "--project",
    "chromium",
    "--headed",
    "--config",
    "configs/pw.config.ts",
  ]);
  assert.deepEqual(full.extraEnv, { PLAYWRIGHT_BASE_URL: "https://staging.example.com" });
});

test("cypress argv always starts with the fixed package and subcommand", () => {
  const { args } = buildCypressArgs({}, noRunnerCypress, undefined);
  assert.deepEqual(args, ["cypress", "run"]);

  const full = buildCypressArgs(
    { spec: "cypress/e2e/login.cy.ts", browser: "chrome" },
    { e2e: true, configFile: "cypress/configs/hybrid.config.ts", project: "hybrid", environmentVar: "ENVIRONMENT" },
    { name: "staging", baseUrl: "https://staging.example.com" },
  );
  assert.deepEqual(full.args, [
    "cypress",
    "run",
    "--spec",
    "cypress/e2e/login.cy.ts",
    "--browser",
    "chrome",
    "--e2e",
    "--config-file",
    "cypress/configs/hybrid.config.ts",
    "--env",
    "target=staging",
  ]);
  assert.deepEqual(full.extraEnv, {
    CYPRESS_BASE_URL: "https://staging.example.com",
    ENVIRONMENT: "staging",
    PROJECT: "hybrid",
  });
});

test("no caller value can reach node -e or pnpm exec through a run tool", () => {
  for (const value of HOSTILE) {
    for (const build of [
      () => buildPlaywrightArgs({ testPath: value }, noRunnerPlaywright, undefined).args,
      () => buildPlaywrightArgs({ project: value }, noRunnerPlaywright, undefined).args,
      () => buildCypressArgs({ spec: value }, noRunnerCypress, undefined).args,
      () => buildCypressArgs({ browser: value }, noRunnerCypress, undefined).args,
    ]) {
      let args: string[];
      try {
        args = build();
      } catch (err) {
        assert.ok(err instanceof CallerArgError, `expected CallerArgError for ${JSON.stringify(value)}`);
        continue;
      }
      // Accepted values stay a single argv entry after the fixed prefix.
      assert.ok(args[0] === "playwright" || args[0] === "cypress", `argv[0] fixed for ${JSON.stringify(value)}`);
      assert.ok(args[1] === "test" || args[1] === "run", `argv[1] fixed for ${JSON.stringify(value)}`);
      assert.ok(!args.includes("node"), `"node" must never be an argv entry (${JSON.stringify(value)})`);
      assert.ok(!args.includes("pnpm"), `"pnpm" must never be an argv entry (${JSON.stringify(value)})`);
      assert.ok(!args.includes("-e"), `"-e" must never be an argv entry (${JSON.stringify(value)})`);
      assert.ok(!args.includes("exec"), `"exec" must never be an argv entry (${JSON.stringify(value)})`);
      for (const entry of args.slice(2)) {
        assert.ok(!entry.startsWith("-") || ["--project", "--headed", "--spec", "--browser"].includes(entry),
          `caller value became an option: ${JSON.stringify(entry)}`);
      }
    }
  }
});

test("values with spaces or shell metacharacters stay one inert argv entry", () => {
  const value = 'node -e "process.exit(1)"';
  const { args } = buildPlaywrightArgs({ testPath: value }, noRunnerPlaywright, undefined);
  assert.deepEqual(args, ["playwright", "test", value]);
  const cy = buildCypressArgs({ spec: "a; rm -rf / && $(id)" }, noRunnerCypress, undefined);
  assert.deepEqual(cy.args, ["cypress", "run", "--spec", "a; rm -rf / && $(id)"]);
});

test("callerArg refuses option-like values, absolute paths and traversal", () => {
  assert.throws(() => callerArg("-e", "x"), /starting with "-"/);
  assert.throws(() => callerArg("--config=evil.js", "x"), /starting with "-"/);
  assert.throws(() => callerArg("/tmp/evil.spec.ts", "x"), /absolute paths/);
  assert.throws(() => callerArg("C:/evil.spec.ts", "x"), /absolute paths/);
  assert.throws(() => callerArg("\\\\server\\share", "x"), /absolute paths/);
  assert.throws(() => callerArg("../evil.spec.ts", "x"), /path traversal/);
  assert.throws(() => callerArg("tests\\..\\evil.spec.ts", "x"), /path traversal/);
  assert.equal(callerArg("tests/login.spec.ts", "x"), "tests/login.spec.ts");
  assert.equal(callerArg("  chromium\n", "x"), "chromium");
  assert.equal(callerArg("\n\t", "x"), "", "control-only input sanitizes to empty, not an error");
});

test("control characters cannot smuggle a second option into a value", () => {
  // The newline is stripped, so the value stays one entry and never starts a new option.
  const { args } = buildCypressArgs({ spec: "login.cy.ts\n--config=/tmp/evil.js" }, noRunnerCypress, undefined);
  assert.deepEqual(args, ["cypress", "run", "--spec", "login.cy.ts--config=/tmp/evil.js"]);
});

test("the allowlist is unchanged and the adapter only ever asks for npx", () => {
  assert.deepEqual([...ALLOWED_COMMANDS], ["npx", "pnpm", "node"]);
});
