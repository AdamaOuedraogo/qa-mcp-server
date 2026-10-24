import type { TestSuiteObservation } from "./schema.js";

/**
 * Output-boundary redaction.
 *
 * The scanner masks what it recognises, but an observation can also be
 * supplied by the caller (`audit_test_suite({ observation })`) and bypass the
 * scanner entirely. So every snippet that can reach the judgment goes through
 * this module in the evaluator, whatever its source. The judgment is meant to
 * be pasted into a client report; it must not carry credentials.
 *
 * Deliberately broad: when a line *looks* like it carries a credential, every
 * quoted literal on it is replaced. Losing a selector in an evidence line is
 * cheap; leaking a password is not.
 */

const CREDENTIAL_CONTEXT = [
  /password|passwd|pwd|mot ?de ?passe|secret|token|api[_-]?key|apikey|auth|bearer|credential|private[_-]?key|client[_-]?secret|access[_-]?key/i,
];

const BARE_SECRET_SHAPES = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, // Authorization header values
  /\b(sk|pk|rk|ghp|gho|glpat|xox[abp]|AKIA)[-_][A-Za-z0-9_-]{8,}\b/g, // common key prefixes
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, // JWT
];

const QUOTED_LITERAL = /(['"`])(?:(?!\1)[^\\\n]|\\.)*\1/g;

/** Mask credential-looking content in one line of text. Pure. */
export function redactLine(line: string): string {
  let out = line;
  for (const re of BARE_SECRET_SHAPES) out = out.replace(re, "***");
  if (CREDENTIAL_CONTEXT.some((re) => re.test(out))) {
    out = out.replace(QUOTED_LITERAL, (m) => (m.length <= 2 ? m : `${m[0]}***${m[0]}`));
  }
  return out;
}

/** Return a deep copy of the observation with every snippet redacted. */
export function redactObservation(obs: TestSuiteObservation): TestSuiteObservation {
  const copy: TestSuiteObservation = JSON.parse(JSON.stringify(obs));
  for (const spec of copy.specs) {
    for (const key of [
      "hardWaits",
      "focusedTests",
      "skippedTests",
      "forcedActions",
      "fragileSelectors",
      "conditionalFlow",
      "hardcodedSecrets",
      "hardcodedUrls",
      "uiLoginSteps",
    ] as const) {
      for (const occ of spec[key]) occ.snippet = redactLine(occ.snippet);
    }
    spec.path = redactLine(spec.path);
  }
  copy.scanNotes = copy.scanNotes.map(redactLine);
  if (copy.runnerConfig.configFile) copy.runnerConfig.configFile = redactLine(copy.runnerConfig.configFile);
  copy.ci.files = copy.ci.files.map(redactLine);
  if (copy.projectName) copy.projectName = redactLine(copy.projectName);
  return copy;
}
