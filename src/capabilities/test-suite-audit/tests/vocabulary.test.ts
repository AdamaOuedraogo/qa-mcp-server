import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Risk-tag vocabulary: the audit capabilities, their resource and prompt, and
 * the project docs all name the levels "P0 / P1 / P2". Severity is a separate
 * scale (critical / high / medium / low) and is not covered here. The tag
 * syntax in test titles (`@p0`, `@p1`, `@p2`) is code and stays lowercase.
 */

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const FILES = [
  "src/capabilities/test-suite-audit/rules.ts",
  "src/capabilities/test-suite-audit/schema.ts",
  "src/capabilities/test-suite-audit/docs/reasoning.md",
  "src/capabilities/test-suite-audit/README.md",
  "src/capabilities/test-strategy-assessment/rules.ts",
  "src/capabilities/test-strategy-assessment/schema.ts",
  "src/capabilities/test-strategy-assessment/README.md",
  "src/resources/auditRubric.ts",
  "src/prompts/qaAudit.ts",
  "ROADMAP.md",
  "docs/vision.md",
];

/** Spellings that drift from "P0 / P1 / P2": no spaces, a dropped level, or "P0 = …, P1, P2". */
const DRIFT = [/\bP0\/P1\b/, /\bP0, P1\b/, /\bP0 = /, /\bP0 \/ P1\b(?! \/ P2)/];

test("risk tags are written P0 / P1 / P2 in every audit source and doc", async () => {
  const offences: string[] = [];
  for (const rel of FILES) {
    const lines = (await readFile(join(repo, rel), "utf8")).split("\n");
    lines.forEach((line, i) => {
      for (const re of DRIFT) if (re.test(line)) offences.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offences, []);
});

test("the COV-001 recommendation names all three levels and the tag syntax", async () => {
  const rules = await readFile(join(repo, "src/capabilities/test-suite-audit/rules.ts"), "utf8");
  assert.match(rules, /business risk as P0 \/ P1 \/ P2 \(P0: revenue, compliance and auth journeys\), tag the tests @p0 \/ @p1 \/ @p2/);
});
