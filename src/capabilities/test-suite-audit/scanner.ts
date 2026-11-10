import { open, readdir, type FileHandle } from "node:fs/promises";
import { join, relative, sep, basename, extname } from "node:path";
import type {
  CiObservation,
  Framework,
  Occurrence,
  RepoObservation,
  RunnerConfigObservation,
  SpecObservation,
  TestSuiteObservation,
} from "./schema.js";

/**
 * Static scanner: a project directory in, a *TestSuiteObservation* out.
 *
 * It contains no judgment — only the facts a reviewer would collect by opening
 * files: where the specs are, what the config says, what CI does. The
 * expertise that turns these facts into findings lives in ./rules.ts.
 *
 * Bounded by construction: it never follows symlinks, skips vendor/build
 * directories, caps the number of files it opens and the size of each, and
 * records every cap it hits in `scanNotes` so the audit can state what it
 * did not see. It never executes anything.
 */

export interface ScanOptions {
  /** Max spec files to open. Others are counted but not analysed. */
  maxSpecFiles?: number;
  /** Max bytes read per file. */
  maxFileBytes?: number;
  /** Max occurrences kept per signal per file (evidence, not a census). */
  maxOccurrencesPerSignal?: number;
}

const DEFAULTS: Required<ScanOptions> = {
  maxSpecFiles: 400,
  maxFileBytes: 512 * 1024,
  maxOccurrencesPerSignal: 5,
};

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  "test-results",
  "playwright-report",
  "cypress/videos",
  "cypress/screenshots",
  ".cache",
  ".turbo",
  "vendor",
  "target",
]);

const SPEC_FILE = /\.(spec|test|cy|e2e)\.(ts|tsx|js|jsx|mjs|cjs)$/i;
const CYPRESS_DIR_SPEC = /(^|\/)cypress\/(e2e|integration)\/.*\.(ts|js|tsx|jsx)$/i;
const FEATURE_FILE = /\.feature$/i;

// --- Spec-level detectors ----------------------------------------------------
// Each regex names a *review smell*, not a syntax. They are deliberately
// conservative: a false negative costs a missed remark, a false positive costs
// the auditor's credibility.

const TEST_BLOCK = /^\s*(test|it)(\.only|\.skip|\.fixme|\.todo)?\s*\(/;
const DESCRIBE_BLOCK = /^\s*(test\.describe|describe|context)(\.only|\.skip)?\s*\(/;

const HARD_WAIT = [
  /\.waitForTimeout\s*\(/,
  /\bcy\.wait\s*\(\s*\d+\s*\)/,
  /\bsetTimeout\s*\(/,
  /\bsleep\s*\(\s*\d+/,
  /\.pause\s*\(\s*\d+/,
];
const FOCUSED = [/\b(test|it|describe|context)\.only\s*\(/, /\bfit\s*\(/, /\bfdescribe\s*\(/];
const SKIPPED = [
  /\b(test|it|describe|context)\.(skip|fixme)\s*\(/,
  /\bxit\s*\(/,
  /\bxdescribe\s*\(/,
  /\bthis\.skip\s*\(\s*\)/,
];
const FORCED = [/force\s*:\s*true/];
const FRAGILE_SELECTOR = [
  /\$x\s*\(|xpath\s*=|\/\/[a-z*]+\[/i, // XPath
  /:nth-child\s*\(|:nth-of-type\s*\(/, // positional CSS
  /['"`](div|span|ul|li|td|tr|p)\s*>\s*(div|span|ul|li|td|tr|p|a|button)/, // tag chains
  /locator\s*\(\s*['"`][^'"`]*\.[a-zA-Z0-9_-]+\s+\.[a-zA-Z0-9_-]+/, // ".a .b" class chains
  /cy\.get\s*\(\s*['"`][^'"`]*\.[a-zA-Z0-9_-]+\s+\.[a-zA-Z0-9_-]+/,
  /cy\.get\s*\(\s*['"`](div|span|ul|li|td|tr|p)\b/,
];
const SEMANTIC_LOCATOR = [
  /\.getBy(Role|Label|Text|Placeholder|TestId|Title|AltText)\s*\(/,
  /\bcy\.(findByRole|findByLabelText|findByText|findByTestId|getByTestId)\s*\(/,
  /\bcy\.get\s*\(\s*['"`]\[data-(test|testid|test-id|cy)=/,
];
const CONDITIONAL = [/^\s*if\s*\(/, /^\s*}\s*else\b/, /^\s*try\s*{/, /^\s*catch\s*\(/];
const SECRET = [
  /(password|passwd|pwd|secret|token|apikey|api_key)\s*[:=]\s*['"`][^'"`]{4,}['"`]/i,
  // fill/type into a password field with a literal value: page.fill('#password', 'x'), cy.get('#pwd').type('x')
  /\.(fill|type)\s*\(\s*['"`][^'"`]*(password|passwd|pwd|mot ?de ?passe)[^'"`]*['"`]\s*,\s*['"`][^'"`]{4,}['"`]/i,
  /(password|passwd|pwd)[^'"`\n]*['"`]\s*\)\s*\.(fill|type)\s*\(\s*['"`][^'"`]{4,}['"`]/i,
  /(?:^|[^a-zA-Z0-9_$])(?:getBy(?:Label|Placeholder|Role)\s*\(\s*['"`][^'"`]*password[^'"`]*['"`][^)]*\))\s*\.(fill|type)\s*\(\s*['"`][^'"`]{4,}['"`]/i,
];
const HARD_URL = [/['"`]https?:\/\/(?!localhost|127\.0\.0\.1|example\.com|example\.org)[^'"`\s]+['"`]/i];
const UI_LOGIN = [
  /\.(fill|type)\s*\([^)]*(password|mot ?de ?passe)[^)]*\)/i,
  /\bgetBy(Label|Placeholder|Role)\s*\(\s*['"`][^'"`]*password/i,
  /\bcy\.get\s*\([^)]*password[^)]*\)\s*\.type\s*\(/i,
];
const SESSION_REUSE = [/storageState/, /cy\.session\s*\(/, /globalSetup/, /\bauth\.setup\b/];
const PAGE_OBJECT_IMPORT = [
  /from\s+['"`][^'"`]*(page|pages|pageobjects?|page-objects?|fixtures?|support|commands|helpers?|components?)[^'"`]*['"`]/i,
  /require\s*\(\s*['"`][^'"`]*(page|pages|fixtures?|support|commands)[^'"`]*['"`]\s*\)/i,
  /test\.extend\s*</,
  /\bimport\s*{[^}]*\btest\b[^}]*}\s*from\s+['"`]\.{1,2}\//, // custom fixture-based test
];
const PRIORITY_TAG = /@(p[0-3]|smoke|sanity|critical|regression|nightly|slow|wip)\b/gi;
// Inline assertions, plus calls to helpers whose *name* says they assert
// (`verifyTotal()`, `assertLoggedIn()`, `checkoutPage.shouldShowError()`).
// This is a heuristic: a helper named `confirmOrder()` that asserts inside
// is still missed, and the finding it feeds (COV-004) says so.
const ASSERTION = [
  /\bexpect\s*\(/,
  /\.should\s*\(/,
  /\bassert\b/,
  /\.toMatchSnapshot\s*\(/,
  /\b(assert|verify|check|validate|expect|should)[A-Z_]\w*\s*\(/,
  /\.(assert|verify|check|validate|expect|should)[A-Z_]?\w*\s*\(/,
];

function matchAny(line: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(line));
}

function pushOcc(list: Occurrence[], line: number, text: string, cap: number): void {
  if (list.length >= cap) return;
  list.push({ line, snippet: text.trim().slice(0, 200) });
}

/** Analyse one spec file's text. Exported for tests; pure. */
export function analyseSpec(path: string, source: string, cap = DEFAULTS.maxOccurrencesPerSignal): SpecObservation {
  const lines = source.split(/\r?\n/);
  const obs: SpecObservation = {
    path,
    lines: lines.length,
    tests: 0,
    hardWaits: [],
    focusedTests: [],
    skippedTests: [],
    forcedActions: [],
    fragileSelectors: [],
    conditionalFlow: [],
    hardcodedSecrets: [],
    hardcodedUrls: [],
    uiLoginSteps: [],
    testsWithoutAssertion: 0,
    usesSemanticLocators: false,
    usesPageObjectOrFixture: false,
    priorityTags: [],
  };

  const tags = new Set<string>();
  let depth = 0; // brace depth, to know when we're inside a test body
  let inTest = false;
  let testDepth = 0;
  let testHasAssertion = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const n = i + 1;
    const trimmed = raw.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    const startsTest = TEST_BLOCK.test(raw);
    if (startsTest) {
      if (inTest && !testHasAssertion) obs.testsWithoutAssertion++;
      obs.tests++;
      inTest = true;
      testDepth = depth;
      testHasAssertion = false;
    }
    if (TEST_BLOCK.test(raw) || DESCRIBE_BLOCK.test(raw)) {
      for (const m of raw.matchAll(PRIORITY_TAG)) tags.add(m[0].toLowerCase());
    }
    if (/grep\s*:|tag\s*:|tags\s*:/.test(raw)) {
      for (const m of raw.matchAll(PRIORITY_TAG)) tags.add(m[0].toLowerCase());
    }

    if (matchAny(raw, HARD_WAIT)) pushOcc(obs.hardWaits, n, raw, cap);
    if (matchAny(raw, FOCUSED)) pushOcc(obs.focusedTests, n, raw, cap);
    if (matchAny(raw, SKIPPED)) pushOcc(obs.skippedTests, n, raw, cap);
    if (matchAny(raw, FORCED)) pushOcc(obs.forcedActions, n, raw, cap);
    if (matchAny(raw, FRAGILE_SELECTOR)) pushOcc(obs.fragileSelectors, n, raw, cap);
    if (matchAny(raw, SECRET)) pushOcc(obs.hardcodedSecrets, n, raw.replace(/['"`][^'"`]+['"`]/g, "'***'"), cap);
    if (matchAny(raw, HARD_URL)) pushOcc(obs.hardcodedUrls, n, raw, cap);
    if (matchAny(raw, UI_LOGIN)) pushOcc(obs.uiLoginSteps, n, raw.replace(/['"`][^'"`]+['"`]/g, "'***'"), cap);
    if (inTest && matchAny(raw, CONDITIONAL)) pushOcc(obs.conditionalFlow, n, raw, cap);
    if (matchAny(raw, SEMANTIC_LOCATOR)) obs.usesSemanticLocators = true;
    if (matchAny(raw, PAGE_OBJECT_IMPORT)) obs.usesPageObjectOrFixture = true;
    if (inTest && matchAny(raw, ASSERTION)) testHasAssertion = true;

    // Track braces to detect the end of a test body (good enough for specs).
    // On the line that opens a test, `({ page }) => {` closes a brace before
    // opening the body, so only the line's *net* change counts there.
    for (const ch of raw) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (!startsTest && inTest && depth <= testDepth) endTest();
      }
    }
    if (startsTest && depth <= testDepth) endTest(); // one-liner test
  }
  if (inTest && !testHasAssertion) obs.testsWithoutAssertion++;

  function endTest(): void {
    if (!testHasAssertion) obs.testsWithoutAssertion++;
    inTest = false;
    testHasAssertion = false;
  }

  obs.priorityTags = [...tags].sort();
  return obs;
}

// --- Config detectors --------------------------------------------------------

function bool(re: RegExp, src: string): boolean | undefined {
  return re.test(src) ? true : undefined;
}

/** Read what matters from a Playwright or Cypress config source. Pure. */
export function analyseRunnerConfig(configFile: string | undefined, source: string, framework: Framework): RunnerConfigObservation {
  const reporters = new Set<string>();
  for (const m of source.matchAll(/['"`](html|json|junit|list|dot|line|github|blob|allure-playwright|mochawesome|mocha-junit-reporter|cypress-multi-reporters|spec)['"`]/g)) {
    reporters.add(m[1]!);
  }
  const retries = source.match(/retries\s*:\s*(\d+)/)?.[1];
  const retriesTernary = /retries\s*:\s*process\.env\.CI\s*\?\s*(\d+)/.exec(source)?.[1];
  const workersNum = source.match(/workers\s*:\s*(\d+)/)?.[1];
  const workersPct = source.match(/workers\s*:\s*['"`](\d+%)['"`]/)?.[1];
  const projects = (source.match(/\bname\s*:\s*['"`][^'"`]+['"`]/g) ?? []).length;
  const timeout = source.match(/^\s*timeout\s*:\s*(\d+)/m)?.[1];

  const traceVal = source.match(/trace\s*:\s*['"`]([a-z-]+)['"`]/)?.[1];
  const screenshotVal = source.match(/screenshot(OnRunFailure)?\s*:\s*(['"`]([a-z-]+)['"`]|true|false)/);
  const videoVal = source.match(/video\s*:\s*(['"`]([a-z-]+)['"`]|true|false)/);

  return {
    configFile,
    retries: retriesTernary !== undefined ? Number(retriesTernary) : retries !== undefined ? Number(retries) : undefined,
    workers: workersPct ?? (workersNum !== undefined ? Number(workersNum) : undefined),
    fullyParallel: bool(/fullyParallel\s*:\s*true/, source),
    reporters: [...reporters].sort(),
    traceOnFailure:
      framework === "cypress" ? undefined : traceVal ? traceVal !== "off" : source.includes("trace") ? undefined : false,
    screenshotOnFailure: screenshotVal
      ? screenshotVal[2] !== "false" && screenshotVal[3] !== "off"
      : framework === "cypress"
        ? true // Cypress default: screenshotOnRunFailure=true
        : undefined,
    videoOnFailure: videoVal ? videoVal[1] !== "false" && videoVal[2] !== "off" : undefined,
    baseUrlConfigured: /baseURL\s*:|baseUrl\s*:/.test(source),
    testIdAttributeConfigured: bool(/testIdAttribute\s*:/, source),
    storageStateOrSession: matchAny(source, SESSION_REUSE),
    projects: framework === "playwright" ? projects || undefined : undefined,
    globalTimeoutMs: timeout ? Number(timeout) : undefined,
  };
}

/** Strip YAML comments so a commented-out job or a `# TODO: add playwright` line is not evidence. */
function stripYamlComments(src: string): string {
  return src
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)#.*$/, ""))
    .join("\n");
}

// A job that actually *runs* E2E tests, not one that merely mentions a tool
// (an `image: mcr.microsoft.com/playwright` line, a cache key, a comment).
const E2E_RUN_COMMAND = [
  /\b(npx|pnpm|yarn|bunx?)\s+(dlx\s+)?playwright\s+test\b/i,
  /\bplaywright\s+test\b/i,
  /\b(npx|pnpm|yarn|bunx?)\s+(dlx\s+)?cypress\s+run\b/i,
  /\bcypress\s+run\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test:)?(e2e|playwright|cypress|ui)(:[\w-]+)?\b/i,
  /\buses:\s*cypress-io\/github-action/i,
];

/** Read the CI definition(s). Pure. */
export function analyseCi(files: Array<{ path: string; source: string }>): CiObservation {
  if (files.length === 0) {
    return { provider: "none", files: [], e2eJobPresent: false };
  }
  const all = files.map((f) => stripYamlComments(f.source)).join("\n");
  const gitlab = files.some((f) => basename(f.path) === ".gitlab-ci.yml");
  const github = files.some((f) => f.path.includes(".github/workflows"));
  const e2e = matchAny(all, E2E_RUN_COMMAND);
  if (!e2e) {
    // No run command: say what we did *not* observe rather than guessing at gates.
    return { provider: gitlab ? "gitlab" : github ? "github" : "other", files: files.map((f) => f.path), e2eJobPresent: false };
  }
  return {
    provider: gitlab ? "gitlab" : github ? "github" : "other",
    files: files.map((f) => f.path),
    e2eJobPresent: true,
    runsOnMergeRequest: bool(/merge_request_event|merge_requests\b|pull_request\b|CI_MERGE_REQUEST_IID/i, all),
    scheduledRun: bool(/CI_PIPELINE_SOURCE\s*==\s*["']schedule["']|^\s*schedule\s*:|^\s*-\s*cron\s*:|\bschedules\b/im, all),
    artifactsPublished: bool(/^\s*artifacts\s*:|uses:\s*actions\/upload-artifact/im, all),
    junitReportWired: bool(/^\s*junit\s*:|reports\s*:\s*\n?\s*junit|junit\.xml|junit-report/im, all),
    parallelOrSharded: bool(/^\s*parallel\s*:|--shard[= ]|^\s*matrix\s*:|\$\{\{\s*matrix\./im, all),
    blanketJobRetry: bool(/^\s*retry\s*:\s*[12]\b|^\s*retry\s*:\s*\n\s*max\s*:\s*[12]\b/m, all),
    dependencyCache: bool(/^\s*cache\s*:|uses:\s*actions\/cache|cache:\s*['"]?(npm|pnpm|yarn)/im, all),
  };
}

// --- Directory walk -----------------------------------------------------------

interface Found {
  specs: string[];
  features: string[];
  configs: string[];
  ciFiles: string[];
  packageJson?: string;
  tsconfig?: string;
  lint: boolean;
  formatter: boolean;
  lockfile: boolean;
  readmes: string[];
  pageObjectsDir: boolean;
  fixturesDir: boolean;
}

async function walk(root: string, maxFiles: number, notes: string[]): Promise<Found> {
  const found: Found = {
    specs: [],
    features: [],
    configs: [],
    ciFiles: [],
    lint: false,
    formatter: false,
    lockfile: false,
    readmes: [],
    pageObjectsDir: false,
    fixturesDir: false,
  };
  let visited = 0;
  const HARD_CAP = 20_000;
  const stack: string[] = [root];

  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++visited > HARD_CAP) {
        notes.push(`Directory walk stopped after ${HARD_CAP} entries.`);
        return found;
      }
      const abs = join(dir, e.name);
      const rel = relative(root, abs).split(sep).join("/");
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || SKIP_DIRS.has(rel)) continue;
        const lower = e.name.toLowerCase();
        if (/^(pages?|page-?objects?|pom|screens?)$/.test(lower)) found.pageObjectsDir = true;
        if (/^(fixtures?|seeds?|test-?data|data)$/.test(lower)) found.fixturesDir = true;
        if (rel === ".github/workflows" || e.name === ".github") {
          stack.push(abs);
          continue;
        }
        if (e.name.startsWith(".") && e.name !== ".github") continue;
        stack.push(abs);
        continue;
      }
      if (!e.isFile()) continue;
      const name = e.name;
      const lower = name.toLowerCase();
      if (SPEC_FILE.test(name) || CYPRESS_DIR_SPEC.test(rel)) found.specs.push(rel);
      else if (FEATURE_FILE.test(name)) found.features.push(rel);
      else if (/^(playwright|cypress)\.config\.(ts|js|mjs|cjs|mts)$/.test(name)) found.configs.push(rel);
      else if (name === "cypress.json") found.configs.push(rel);
      else if (name === ".gitlab-ci.yml" && rel === name) found.ciFiles.push(rel);
      else if (rel.startsWith(".github/workflows/") && /\.ya?ml$/.test(name)) found.ciFiles.push(rel);
      else if (name === "package.json" && rel === name) found.packageJson = rel;
      else if (name === "tsconfig.json" && rel === name) found.tsconfig = rel;
      else if (/^(\.eslintrc|eslint\.config|biome\.json)/.test(lower)) found.lint = true;
      else if (/^(\.prettierrc|prettier\.config|biome\.json)/.test(lower)) found.formatter = true;
      else if (/^(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/.test(name) && rel === name) found.lockfile = true;
      else if (/^(readme|contributing|testing)/i.test(name) && /\.md$/i.test(name)) found.readmes.push(rel);
    }
  }
  if (found.specs.length > maxFiles) {
    notes.push(`${found.specs.length} spec files found; only the first ${maxFiles} (sorted) were analysed.`);
  }
  found.specs.sort();
  return found;
}

/**
 * Read at most `maxBytes` bytes of a file as UTF-8. The buffer is sized to
 * `min(size, maxBytes)` and filled with positional reads, so memory use is
 * bounded by the cap, not by the file size. Exported for tests only; not
 * exposed over MCP.
 */
export async function readCapped(abs: string, maxBytes: number, notes: string[], rel: string): Promise<string> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(abs, "r");
    const st = await fh.stat();
    if (!st.isFile()) throw new Error("not a regular file");
    const size = st.size;
    if (size > maxBytes) notes.push(`${rel}: truncated to ${maxBytes} bytes.`);
    const buf = Buffer.alloc(Math.max(0, Math.min(size, maxBytes)));
    let filled = 0;
    while (filled < buf.length) {
      const { bytesRead } = await fh.read(buf, filled, buf.length - filled, filled);
      if (bytesRead === 0) break; // file shrank after stat
      filled += bytesRead;
    }
    return buf.subarray(0, filled).toString("utf8");
  } catch (err) {
    notes.push(`${rel}: could not be read (${err instanceof Error ? err.message : String(err)}).`);
    return "";
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/**
 * Scan a project directory and return a bounded observation. Never throws for
 * unreadable files — it records a note instead, so a partial scan is still an
 * honest observation.
 */
export async function scanProject(root: string, options: ScanOptions = {}): Promise<TestSuiteObservation> {
  const opt = { ...DEFAULTS, ...options };
  const notes: string[] = [];
  const found = await walk(root, opt.maxSpecFiles, notes);

  // Framework
  const hasPw = found.configs.some((c) => c.startsWith("playwright")) || found.specs.some((s) => /\.spec\.(ts|js)/.test(s) && !/cypress/.test(s));
  const hasCy = found.configs.some((c) => c.startsWith("cypress")) || found.specs.some((s) => /cypress\/|\.cy\./.test(s));
  const framework: Framework = hasPw && hasCy ? "mixed" : hasPw ? "playwright" : hasCy ? "cypress" : "unknown";

  // Specs
  const specs: SpecObservation[] = [];
  for (const rel of found.specs.slice(0, opt.maxSpecFiles)) {
    const src = await readCapped(join(root, rel), opt.maxFileBytes, notes, rel);
    if (src) specs.push(analyseSpec(rel, src, opt.maxOccurrencesPerSignal));
  }
  if (found.features.length) notes.push(`${found.features.length} Gherkin .feature files found (BDD layer) — step definitions were analysed as specs only if they match spec naming.`);

  // Runner config (prefer the file matching the dominant framework)
  const configRel = found.configs.find((c) => (framework === "cypress" ? c.startsWith("cypress") : c.startsWith("playwright"))) ?? found.configs[0];
  const configSrc = configRel ? await readCapped(join(root, configRel), opt.maxFileBytes, notes, configRel) : "";
  const runnerConfig = analyseRunnerConfig(configRel, configSrc, framework);
  if (!configRel) notes.push("No playwright.config/cypress.config found at or below the audited root.");
  // storageState/session may live in specs/support rather than the config.
  if (!runnerConfig.storageStateOrSession) {
    for (const rel of found.specs.slice(0, opt.maxSpecFiles)) {
      if (/auth\.setup|\.session\./.test(rel)) {
        runnerConfig.storageStateOrSession = true;
        break;
      }
    }
  }

  // CI
  const ciFiles: Array<{ path: string; source: string }> = [];
  for (const rel of found.ciFiles.slice(0, 20)) {
    ciFiles.push({ path: rel, source: await readCapped(join(root, rel), opt.maxFileBytes, notes, rel) });
  }
  const ci = analyseCi(ciFiles);

  // Repo
  const pkgSrc = found.packageJson ? await readCapped(join(root, found.packageJson), opt.maxFileBytes, notes, found.packageJson) : "";
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    pkg = pkgSrc ? JSON.parse(pkgSrc) : {};
  } catch {
    notes.push("package.json could not be parsed.");
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const scripts = Object.entries(pkg.scripts ?? {});
  const tsSrc = found.tsconfig ? await readCapped(join(root, found.tsconfig), opt.maxFileBytes, notes, found.tsconfig) : "";
  const readmeTexts = await Promise.all(found.readmes.slice(0, 5).map((r) => readCapped(join(root, r), opt.maxFileBytes, notes, r)));
  const repo: RepoObservation = {
    typescript: Boolean(found.tsconfig) || specs.some((s) => extname(s.path) === ".ts"),
    tsStrict: tsSrc ? /"strict"\s*:\s*true/.test(tsSrc) : undefined,
    lintConfigured: found.lint || Boolean(deps["eslint"] ?? deps["@biomejs/biome"]),
    formatterConfigured: found.formatter || Boolean(deps["prettier"]),
    lockfile: found.lockfile,
    e2eScript: scripts.some(([k, v]) => /e2e|playwright|cypress|test:ui|test:int/i.test(k) || /playwright test|cypress run/i.test(v)),
    testingReadme: readmeTexts.some((t) => /##?\s*(test|e2e|qa|automation)/i.test(t)) || found.readmes.some((r) => /testing/i.test(r)),
    pageObjectsDir: found.pageObjectsDir,
    fixturesOrSeedDir: found.fixturesDir,
    frameworkVersion: deps["@playwright/test"] ?? deps["playwright"] ?? deps["cypress"],
    packageJsonFound: Boolean(found.packageJson) && Object.keys(pkg).length > 0,
  };

  return {
    projectName: basename(root),
    framework,
    specs,
    totalSpecFilesFound: found.specs.length,
    runnerConfig,
    ci,
    repo,
    scanNotes: notes,
  };
}
