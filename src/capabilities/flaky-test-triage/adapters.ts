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

// --- JUnit XML --------------------------------------------------------------
/**
 * JUnit XML is the lingua franca of CI reporters: `mocha-junit-reporter` (how
 * Cypress emits here), Playwright's `junit` reporter, `jest-junit`, and more all
 * produce this shape — so one adapter covers many stacks. We parse it without an
 * XML dependency, staying tolerant per this file's contract: read defensively,
 * skip what we can't understand, never throw on a malformed report.
 *
 * Two shapes are handled from real reporters:
 *  - `mocha-junit-reporter`: `file` lives on a sibling "Root Suite" `<testsuite>`,
 *    the failing case sits in another suite with no `file`; `name` already carries
 *    the suite prefix. We resolve `file` from the nearest `file=` before the case.
 *  - Playwright `junit`: `<failure message type="FAILURE">`, `classname` is the
 *    suite path, plus `<system-out>` attachment lines we ignore.
 *
 * Important limitation (documented, not a bug): JUnit emits **one `<testcase>` per
 * test — the final outcome**. It does not model retries as separate attempts. So
 * passed-on-retry (our strongest signal) is invisible in JUnit; within-run
 * flakiness for these tests must come from cross-run `history`, or from a richer
 * source like Playwright's JSON reporter (`results[]` per attempt). When a reporter
 * *does* repeat a `<testcase>` for the same test, we fold the repeats into ordered
 * attempts so that signal is not lost.
 */
export function fromJUnitXml(raw: unknown): FlakyTriageInput[] {
  const xml = typeof raw === "string" ? raw : "";
  if (!xml.includes("<testcase")) return [];

  const grouped = new Map<string, { title?: string; filePath?: string; attempts: TestAttempt[] }>();
  // Self-closing `<testcase .../>` (a pass) OR `<testcase ...>…</testcase>`.
  const caseRe = /<testcase\b([^>]*?)\/>|<testcase\b([^>]*?)>([\s\S]*?)<\/testcase>/g;
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(xml))) {
    const attrs = m[1] ?? m[2] ?? "";
    const body = m[3] ?? "";
    const name = xmlAttr(attrs, "name") ?? "unknown";
    const classname = xmlAttr(attrs, "classname");

    // Resolve the spec file: an explicit `file=` on the testcase, else the nearest
    // `file=` appearing before it (mocha-junit puts it on a sibling suite), else
    // the nearest enclosing `<testsuite name="…">`.
    const before = xml.slice(0, m.index);
    const file =
      xmlAttr(attrs, "file") ??
      lastCapture(before, /\bfile\s*=\s*(?:"([^"]*)"|'([^']*)')/g) ??
      lastCapture(before, /<testsuite\b[^>]*?\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/g);

    const failTag = body.match(/<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:failure|error)>)/);
    const status: TestAttempt["status"] = failTag
      ? "failed"
      : /<skipped\b/.test(body)
        ? "skipped"
        : "passed";

    const errorType = failTag ? xmlAttr(failTag[2] ?? "", "type") : undefined;
    const errorMessage = failTag
      ? firstLine(xmlAttr(failTag[2] ?? "", "message")) ?? firstLine(failTag[3])
      : undefined;

    const testId = `${file ?? classname ?? "unknown"} :: ${name}`;
    const entry = grouped.get(testId) ?? { title: name, filePath: file, attempts: [] };
    entry.attempts.push({
      attempt: entry.attempts.length,
      status,
      durationMs: secondsToMs(xmlAttr(attrs, "time")),
      errorType,
      errorMessage,
    });
    grouped.set(testId, entry);
  }

  return [...grouped.entries()].map(([testId, v]) => ({
    testId,
    title: v.title,
    filePath: v.filePath,
    attempts: v.attempts,
  }));
}

// --- format dispatch --------------------------------------------------------
export type ReportFormat = "junit" | "playwright-json" | "mochawesome";

/**
 * One entry point for "a report file → observations", whatever the format. Pass
 * an explicit `format` when you know it; otherwise it auto-detects XML vs JSON
 * and the JSON shape. Reports can be JUnit *or* JSON — this hides that from the
 * caller (and from the future report-level triage runner).
 */
export function parseTestReport(raw: unknown, format?: ReportFormat): FlakyTriageInput[] {
  if (format === "junit") return fromJUnitXml(raw);
  if (format === "playwright-json") return fromPlaywrightJson(raw);
  if (format === "mochawesome") return fromMochawesome(raw);

  let value: unknown = raw;
  if (typeof raw === "string") {
    if (raw.trimStart().startsWith("<")) return fromJUnitXml(raw);
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const root = asRecord(value);
  if (!root) return [];
  if (Array.isArray(root.suites)) return fromPlaywrightJson(root); // Playwright JSON
  if (Array.isArray(root.results)) return fromMochawesome(root); // Mochawesome
  return [];
}

// --- small XML helpers (dependency-free) ------------------------------------

function xmlAttr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return m ? decodeXml(m[1] ?? m[2] ?? "") : undefined;
}

/** The last capture group 1-or-2 across all matches of a global regex. */
function lastCapture(s: string, re: RegExp): string | undefined {
  let m: RegExpExecArray | null;
  let last: string | undefined;
  while ((m = re.exec(s))) last = decodeXml(m[1] ?? m[2] ?? "");
  return last;
}

/** First non-empty line of decoded text (CDATA-aware). Reporters put the useful message first. */
function firstLine(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return decodeXml(s)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#0?39;/g, "'")
    .replace(/&#96;/g, "`")
    .replace(/&amp;/g, "&");
}

function secondsToMs(time: string | undefined): number | undefined {
  if (!time) return undefined;
  const secs = Number(time);
  return Number.isFinite(secs) ? Math.round(secs * 1000) : undefined;
}
