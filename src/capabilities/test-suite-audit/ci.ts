import { basename } from "node:path";
import type { CiObservation } from "./schema.js";

/**
 * CI analysis: GitLab and GitHub Actions files in, a CiObservation out.
 *
 * No YAML parser (no new dependency): files are split into jobs by
 * indentation, conservatively. The rule that keeps it honest:
 *
 *   A setting counts for the E2E job only when it sits in the job that runs
 *   the command. When it is absent from that job but present elsewhere in the
 *   file (another job, `default:`, a template), or the job inherits from
 *   somewhere this splitter does not follow (`extends:`, `<<:`, `!reference`,
 *   a reusable workflow, a local action), the setting is *not established*
 *   (undefined). It is `false` only when it appears nowhere.
 *
 * The run command must sit in a job's `script:`/`before_script:` (GitLab) or
 * in a step's `run:` / `uses: cypress-io/github-action` (GitHub). The same
 * text in `variables:`, `env:` or a template does not make an E2E job.
 *
 * A disabled job (`when: never`, `if: false`, a hidden `.template`) is not an
 * E2E job. A manual-only job, or one allowed to fail, is not a merge-request
 * gate. Anything this splitter cannot decide is left undefined, so the rules
 * report it as not observed rather than as observed.
 */

const E2E_RUN_COMMAND = [
  /\b(npx|pnpm|yarn|bunx?)\s+(dlx\s+)?playwright\s+test\b/i,
  /\bplaywright\s+test\b/i,
  /\b(npx|pnpm|yarn|bunx?)\s+(dlx\s+)?cypress\s+run\b/i,
  /\bcypress\s+run\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test:)?(e2e|playwright|cypress|ui)(:[\w-]+)?\b/i,
  /\buses:\s*cypress-io\/github-action/i,
];

const GITLAB_RESERVED = new Set([
  "stages",
  "variables",
  "include",
  "default",
  "workflow",
  "image",
  "services",
  "cache",
  "before_script",
  "after_script",
]);

/** Strip YAML comments so a commented-out job or a `# TODO: add playwright` line is not evidence. */
export function stripYamlComments(src: string): string {
  return src
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)#.*$/, ""))
    .join("\n");
}

const indentOf = (l: string): number => /^ */.exec(l)![0].length;
const blank = (l: string): boolean => l.trim() === "";
const unquote = (s: string): string => s.trim().replace(/^(["'])(.*)\1$/, "$2");

interface Block {
  key: string;
  inline: string;
  /** Lines after the key line that are indented deeper than it. */
  body: string[];
  start: number;
  end: number;
}

/** Keys at exactly `indent`, each with the deeper-indented lines under it. */
function blocksAt(lines: string[], indent: number, from = 0, to = lines.length): Block[] {
  const out: Block[] = [];
  const keyRe = /^(["']?)([^\s"'#-][^"']*?)\1\s*:(?:\s+(.*))?$/;
  for (let i = from; i < to; i++) {
    const l = lines[i]!;
    if (blank(l) || indentOf(l) !== indent) continue;
    const m = keyRe.exec(l.slice(indent));
    if (!m) continue;
    let j = i + 1;
    while (j < to && (blank(lines[j]!) || indentOf(lines[j]!) > indent)) j++;
    out.push({ key: m[2]!, inline: (m[3] ?? "").trim(), body: lines.slice(i + 1, j), start: i, end: j });
    i = j - 1;
  }
  return out;
}

/** The first indentation level used inside `body`. */
function childIndent(body: string[]): number | undefined {
  const first = body.find((l) => !blank(l));
  return first === undefined ? undefined : indentOf(first);
}

function child(b: Block, key: string): Block | undefined {
  const ind = childIndent(b.body);
  if (ind === undefined) return undefined;
  return blocksAt(b.body, ind).find((c) => c.key === key);
}

const textOf = (b: Block | undefined): string => (b ? [b.inline, ...b.body].join("\n") : "");

/** Split a block's sequence (`- a`, `- if: …\n  when: manual`) into its items. */
function seqItems(b: Block | undefined): string[] {
  if (!b) return [];
  if (b.inline.startsWith("[")) return b.inline.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim());
  const items: string[] = [];
  let ind: number | undefined;
  for (const l of b.body) {
    if (blank(l)) continue;
    const t = l.trimStart();
    if (t.startsWith("- ") || t === "-") {
      if (ind === undefined) ind = indentOf(l);
      if (indentOf(l) === ind) {
        items.push(t.slice(1).trim());
        continue;
      }
    }
    if (items.length) items[items.length - 1] += "\n" + t;
  }
  return items;
}

interface Job {
  file: string;
  name: string;
  /** Text of the job's own commands only. */
  commands: string;
  /** Full text of the job's block. */
  text: string;
  /** Line range of the job in the file, to look for settings elsewhere. */
  start: number;
  end: number;
  disabled: boolean;
  manualOnly: boolean;
  /** Inherits from something this splitter does not follow. */
  inherits: boolean;
  mergeRequestGate: boolean | undefined;
  scheduled: boolean | undefined;
  settings: Record<Setting, boolean>;
}

type Setting = "artifacts" | "junit" | "parallel" | "retry" | "cache";

interface ParsedFile {
  path: string;
  lines: string[];
  jobs: Job[];
  /** The file may pull jobs from elsewhere (GitLab `include:`, a GitHub reusable workflow). */
  includesOthers: boolean;
}

// --- GitLab -------------------------------------------------------------------

function gitlabRuleItem(item: string): { when: string; mr: boolean; schedule: boolean } {
  return {
    when: /\bwhen\s*:\s*(\w+)/.exec(item)?.[1] ?? "on_success",
    mr: /merge_request_event|CI_MERGE_REQUEST_/.test(item),
    schedule: /["']schedule["']/.test(item),
  };
}

function parseGitlab(path: string, src: string): ParsedFile {
  const lines = stripYamlComments(src).split(/\r?\n/);
  const top = blocksAt(lines, 0);
  const jobs: Job[] = [];
  for (const b of top) {
    if (GITLAB_RESERVED.has(b.key)) continue;
    const scripts = ["before_script", "script"].map((k) => textOf(child(b, k))).join("\n");
    const text = textOf(b);
    const whenJob = unquote(child(b, "when")?.inline ?? "");
    const allowFailure = /^true$/.test(unquote(child(b, "allow_failure")?.inline ?? ""));
    const rules = seqItems(child(b, "rules")).map(gitlabRuleItem);
    const only = textOf(child(b, "only"));
    const hidden = b.key.startsWith(".");
    const disabled = hidden || whenJob === "never" || (rules.length > 0 && rules.every((r) => r.when === "never"));
    const live = rules.filter((r) => r.when !== "never");
    const manualOnly =
      !disabled && (whenJob === "manual" || (rules.length > 0 && live.length > 0 && live.every((r) => r.when === "manual")));

    let mergeRequestGate: boolean | undefined;
    const mrRule = rules.find((r) => r.mr);
    if (manualOnly || allowFailure) mergeRequestGate = false;
    else if (mrRule) mergeRequestGate = mrRule.when !== "manual" && mrRule.when !== "never";
    else if (/\bmerge_requests\b/.test(only)) mergeRequestGate = true;

    let scheduled: boolean | undefined;
    const schedRule = rules.find((r) => r.schedule);
    if (schedRule) scheduled = schedRule.when !== "never" && schedRule.when !== "manual";
    else if (/\bschedules\b/.test(only)) scheduled = true;

    const retryBlock = child(b, "retry");
    const retryText = textOf(retryBlock);
    jobs.push({
      file: path,
      name: b.key,
      commands: scripts,
      text,
      start: b.start,
      end: b.end,
      disabled,
      manualOnly,
      inherits: Boolean(child(b, "extends")) || /<<\s*:|!reference/.test(text),
      mergeRequestGate,
      scheduled,
      settings: {
        artifacts: Boolean(child(b, "artifacts")),
        junit: /^\s*junit\s*:/m.test(textOf(child(b, "artifacts"))),
        parallel: Boolean(child(b, "parallel")) || /--shard[= ]/.test(scripts),
        retry: Boolean(retryBlock) && /^\s*[12]\s*$|max\s*:\s*[12]\b/m.test(retryText),
        cache: Boolean(child(b, "cache")),
      },
    });
  }
  return { path, lines, jobs, includesOthers: top.some((b) => b.key === "include") };
}

// --- GitHub Actions -------------------------------------------------------------

/** `run:` values of a job's steps, with their block-scalar continuation lines. */
function githubRunText(body: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const l = body[i]!;
    const m = /^(\s*)(?:-\s+)?run\s*:\s*(.*)$/.exec(l);
    if (m) {
      const keyIndent = indentOf(l) + (l.trimStart().startsWith("-") ? 2 : 0);
      out.push(m[2]!);
      let j = i + 1;
      while (j < body.length && (blank(body[j]!) || indentOf(body[j]!) > keyIndent)) out.push(body[j++]!);
      i = j - 1;
      continue;
    }
    if (/^\s*(-\s+)?uses\s*:\s*cypress-io\/github-action/.test(l)) out.push(l.trim());
  }
  return out.join("\n");
}

function parseGithub(path: string, src: string): ParsedFile {
  const lines = stripYamlComments(src).split(/\r?\n/);
  const top = blocksAt(lines, 0);
  const on = top.find((b) => ["on", "true"].includes(b.key));
  const onText = on ? textOf(on) : "";
  const triggers = new Set<string>();
  for (const m of onText.matchAll(/\b(pull_request_target|pull_request|push|schedule|workflow_dispatch|workflow_call|repository_dispatch|merge_group|release)\b/g)) {
    triggers.add(m[1]!);
  }
  const prTrigger = triggers.has("pull_request") || triggers.has("pull_request_target") || triggers.has("merge_group");
  const manualFile = triggers.size > 0 && [...triggers].every((t) => t === "workflow_dispatch");
  const calledElsewhere = triggers.has("workflow_call");

  const jobsBlock = top.find((b) => b.key === "jobs");
  const jobs: Job[] = [];
  let includesOthers = false;
  if (jobsBlock) {
    const ind = childIndent(jobsBlock.body);
    const offset = jobsBlock.start + 1;
    for (const b of ind === undefined ? [] : blocksAt(jobsBlock.body, ind)) {
      const text = textOf(b);
      const commands = githubRunText(b.body);
      const jobIf = unquote(child(b, "if")?.inline ?? "");
      const reusable = Boolean(child(b, "uses"));
      if (reusable) includesOthers = true;
      const disabled = /^(false|\$\{\{\s*false\s*\}\})$/.test(jobIf);
      const continueOnError = /^true$/.test(unquote(child(b, "continue-on-error")?.inline ?? ""));
      const manualOnly = !disabled && manualFile;

      let mergeRequestGate: boolean | undefined;
      if (manualOnly || continueOnError) mergeRequestGate = false;
      else if (!jobIf && !calledElsewhere && on) mergeRequestGate = prTrigger ? true : undefined;

      let scheduled: boolean | undefined;
      if (!jobIf && !calledElsewhere && on) scheduled = triggers.has("schedule");

      jobs.push({
        file: path,
        name: b.key,
        commands,
        text,
        start: offset + b.start,
        end: offset + b.end,
        disabled,
        manualOnly,
        inherits: reusable || /uses\s*:\s*\.\//.test(text),
        mergeRequestGate,
        scheduled,
        settings: {
          artifacts: /uses\s*:\s*actions\/upload-artifact/.test(text),
          junit: /junit/i.test(text),
          parallel: /^\s*matrix\s*:/m.test(textOf(child(b, "strategy"))) || /--shard[= ]/.test(commands),
          retry: /uses\s*:\s*(nick-fields\/retry|Wandalen\/wretry)/.test(text),
          cache: /uses\s*:\s*actions\/cache|^\s*cache\s*:/m.test(text),
        },
      });
    }
  }
  return { path, lines, jobs, includesOthers };
}

// --- Aggregation --------------------------------------------------------------------

const SETTING_ELSEWHERE: Record<Setting, RegExp> = {
  artifacts: /^\s*artifacts\s*:|uses\s*:\s*actions\/upload-artifact/m,
  junit: /junit/i,
  parallel: /^\s*parallel\s*:|--shard[= ]|^\s*matrix\s*:/m,
  retry: /^\s*retry\s*:|uses\s*:\s*(nick-fields\/retry|Wandalen\/wretry)/m,
  cache: /^\s*cache\s*:|uses\s*:\s*actions\/cache/m,
};

/** True / false / not established for one setting of one E2E job. */
function settingFor(job: Job, file: ParsedFile, s: Setting): boolean | undefined {
  if (job.settings[s]) return true;
  if (job.inherits) return undefined;
  const elsewhere = [...file.lines.slice(0, job.start), ...file.lines.slice(job.end)].join("\n");
  return SETTING_ELSEWHERE[s].test(elsewhere) ? undefined : false;
}

/** Any true → true; all false → false; otherwise not established. */
function anyOf(values: Array<boolean | undefined>): boolean | undefined {
  if (values.some((v) => v === true)) return true;
  if (values.length > 0 && values.every((v) => v === false)) return false;
  return undefined;
}

export function analyseCi(files: Array<{ path: string; source: string }>): CiObservation {
  if (files.length === 0) {
    return { provider: "none", files: [], e2eJobPresent: false };
  }
  const gitlab = files.some((f) => basename(f.path) === ".gitlab-ci.yml");
  const github = files.some((f) => f.path.includes(".github/workflows"));
  const provider = gitlab ? "gitlab" : github ? "github" : "other";
  const parsed = files.map((f) => (f.path.includes(".github/workflows") ? parseGithub(f.path, f.source) : parseGitlab(f.path, f.source)));

  const e2e: Array<{ job: Job; file: ParsedFile }> = [];
  for (const file of parsed) {
    for (const job of file.jobs) {
      if (!job.disabled && E2E_RUN_COMMAND.some((re) => re.test(job.commands))) e2e.push({ job, file });
    }
  }
  const base = { provider, files: files.map((f) => f.path) } as const;

  if (e2e.length === 0) {
    const textHit = parsed.find((p) => E2E_RUN_COMMAND.some((re) => re.test(p.lines.join("\n"))));
    const inherits = parsed.find((p) => p.includesOthers || p.jobs.some((j) => j.inherits && !j.disabled));
    const reason = textHit
      ? `an E2E command appears in ${textHit.path} outside any enabled job's own script (variables, a template, an extended or disabled job)`
      : inherits
        ? `${inherits.path} pulls jobs or steps from elsewhere (include, extends, a reusable workflow or a local action) that were not read`
        : undefined;
    return { ...base, e2eJobPresent: false, ...(reason ? { e2eJobNotEstablished: reason } : {}) };
  }

  const per = (s: Setting) => anyOf(e2e.map(({ job, file }) => settingFor(job, file, s)));
  return {
    ...base,
    e2eJobPresent: true,
    e2eJobs: e2e.map(({ job }) => ({ file: job.file, job: job.name, manualOnly: job.manualOnly })),
    runsOnMergeRequest: anyOf(e2e.map(({ job }) => job.mergeRequestGate)),
    scheduledRun: anyOf(e2e.map(({ job }) => job.scheduled)),
    artifactsPublished: per("artifacts"),
    junitReportWired: per("junit"),
    parallelOrSharded: per("parallel"),
    blanketJobRetry: per("retry"),
    dependencyCache: per("cache"),
  };
}
