import type { FlakyTriageInput, TestAttempt } from "./schema.js";

/**
 * Adapters: tools are only sources of observation.
 *
 * Reporters (Playwright, Mochawesome, JUnit) don't hold expertise — they hold
 * evidence. These functions normalize their raw output into the observation the
 * expertise reasons over. No judgment happens here; that lives in rules.ts.
 *
 * They are intentionally tolerant: reporter shapes drift across versions, so we
 * read defensively and skip what we can't understand rather than throwing.
 */

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function statusFrom(raw: string | undefined): TestAttempt["status"] {
  switch ((raw ?? "").toLowerCase()) {
    case "passed":
    case "pass":
    case "expected":
      return "passed";
    case "timedout":
    case "timed_out":
      return "timedOut";
    case "skipped":
    case "pending":
      return "skipped";
    default:
      return "failed";
  }
}

/**
 * Playwright JSON reporter: suites -> (suites) -> specs -> tests -> results[].
 * Each `result` is one attempt; retries appear as additional results.
 */
export function fromPlaywrightJson(raw: unknown): FlakyTriageInput[] {
  const root = asRecord(raw);
  if (!root) return [];
  const out: FlakyTriageInput[] = [];

  const walkSuite = (suite: unknown, filePath?: string) => {
    const s = asRecord(suite);
    if (!s) return;
    const file = (typeof s.file === "string" ? s.file : undefined) ?? filePath;

    for (const spec of (s.specs as unknown[]) ?? []) {
      const sp = asRecord(spec);
      if (!sp) continue;
      const title = typeof sp.title === "string" ? sp.title : undefined;
      for (const test of (sp.tests as unknown[]) ?? []) {
        const t = asRecord(test);
        if (!t) continue;
        const results = (t.results as unknown[]) ?? [];
        const attempts: TestAttempt[] = results.map((r, i) => {
          const rr = asRecord(r) ?? {};
          const error = asRecord(rr.error);
          return {
            attempt: i,
            status: statusFrom(rr.status as string | undefined),
            durationMs: typeof rr.duration === "number" ? rr.duration : undefined,
            errorMessage:
              (typeof error?.message === "string" ? error.message.split("\n")[0] : undefined) ??
              undefined,
          };
        });
        if (attempts.length === 0) continue;
        out.push({
          testId: `${file ?? "unknown"} :: ${title ?? "unknown"}`,
          title,
          filePath: file,
          attempts,
        });
      }
    }
    for (const child of (s.suites as unknown[]) ?? []) walkSuite(child, file);
  };

  for (const suite of (root.suites as unknown[]) ?? []) walkSuite(suite);
  return out;
}

/**
 * Mochawesome (Cypress' common reporter): results[].suites[].tests[].
 * Mocha reruns aren't retries-as-attempts, so each test yields one attempt; use
 * `history` upstream if you track intermittency across runs.
 */
export function fromMochawesome(raw: unknown): FlakyTriageInput[] {
  const root = asRecord(raw);
  if (!root) return [];
  const out: FlakyTriageInput[] = [];

  const walk = (node: unknown, filePath?: string) => {
    const n = asRecord(node);
    if (!n) return;
    const file = (typeof n.file === "string" ? n.file : undefined) ?? filePath;
    for (const test of (n.tests as unknown[]) ?? []) {
      const t = asRecord(test);
      if (!t) continue;
      const err = asRecord(t.err);
      const status: TestAttempt["status"] = t.pass ? "passed" : t.pending ? "skipped" : "failed";
      out.push({
        testId: `${file ?? "unknown"} :: ${typeof t.fullTitle === "string" ? t.fullTitle : t.title}`,
        title: typeof t.title === "string" ? t.title : undefined,
        filePath: file,
        attempts: [
          {
            attempt: 0,
            status,
            durationMs: typeof t.duration === "number" ? t.duration : undefined,
            errorMessage:
              typeof err?.message === "string" ? err.message.split("\n")[0] : undefined,
          },
        ],
      });
    }
    for (const suite of (n.suites as unknown[]) ?? []) walk(suite, file);
  };

  for (const r of (root.results as unknown[]) ?? []) walk(r);
  return out;
}
