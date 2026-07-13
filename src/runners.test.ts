import { test } from "node:test";
import assert from "node:assert/strict";
import { getCypressRunnerConfig, getPlaywrightRunnerConfig } from "./runners.js";

/** Snapshot/restore the env keys these tests mutate, so tests stay isolated. */
const KEYS = [
  "QA_MCP_CYPRESS_CONFIG_FILE",
  "QA_MCP_CYPRESS_E2E",
  "QA_MCP_CYPRESS_PROJECT",
  "QA_MCP_CYPRESS_ENV_VAR",
  "QA_MCP_PLAYWRIGHT_CONFIG_FILE",
];

function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(values)) if (v !== undefined) process.env[k] = v;
  try {
    fn();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("cypress runner config defaults to a safe empty shape", () => {
  withEnv({}, () => {
    const cfg = getCypressRunnerConfig();
    assert.equal(cfg.configFile, undefined);
    assert.equal(cfg.e2e, false);
    assert.equal(cfg.project, undefined);
    assert.equal(cfg.environmentVar, undefined);
  });
});

test("cypress runner config reads operator env vars", () => {
  withEnv(
    {
      QA_MCP_CYPRESS_CONFIG_FILE: "./cypress/configs/hybrid.config.ts",
      QA_MCP_CYPRESS_E2E: "true",
      QA_MCP_CYPRESS_PROJECT: "hybrid",
      QA_MCP_CYPRESS_ENV_VAR: "ENVIRONMENT",
    },
    () => {
      const cfg = getCypressRunnerConfig();
      assert.equal(cfg.configFile, "./cypress/configs/hybrid.config.ts");
      assert.equal(cfg.e2e, true);
      assert.equal(cfg.project, "hybrid");
      assert.equal(cfg.environmentVar, "ENVIRONMENT");
    },
  );
});

test("cypress e2e flag accepts common truthy spellings and rejects others", () => {
  for (const v of ["1", "true", "YES", "on"]) {
    withEnv({ QA_MCP_CYPRESS_E2E: v }, () => {
      assert.equal(getCypressRunnerConfig().e2e, true, `expected ${v} to be truthy`);
    });
  }
  for (const v of ["0", "false", "no", "", "maybe"]) {
    withEnv({ QA_MCP_CYPRESS_E2E: v }, () => {
      assert.equal(getCypressRunnerConfig().e2e, false, `expected ${v} to be falsy`);
    });
  }
});

test("blank strings are treated as unset", () => {
  withEnv({ QA_MCP_CYPRESS_CONFIG_FILE: "   ", QA_MCP_PLAYWRIGHT_CONFIG_FILE: "" }, () => {
    assert.equal(getCypressRunnerConfig().configFile, undefined);
    assert.equal(getPlaywrightRunnerConfig().configFile, undefined);
  });
});

test("playwright runner config reads its config file", () => {
  withEnv({ QA_MCP_PLAYWRIGHT_CONFIG_FILE: "playwright.config.ts" }, () => {
    assert.equal(getPlaywrightRunnerConfig().configFile, "playwright.config.ts");
  });
});
