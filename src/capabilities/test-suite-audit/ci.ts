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

/** A line that holds one of the run commands above. */
const E2E_LINE: Matcher = { test: (l: string) => E2E_RUN_COMMAND.some((re) => re.test(l)) };

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

/**
 * How the whole file reads an inline value. Supported: an empty value (a
 * block follows), a plain or quoted scalar, and a flow sequence of plain or
 * quoted scalars (`[push, pull_request]`). Everything else is unsupported and
 * makes the construct abstain: flow mappings `{…}`, nested flows, commas or
 * brackets inside quotes, and aliases `*name`.
 */
type Inline =
  | { kind: "empty" }
  | { kind: "scalar"; value: string }
  | { kind: "seq"; items: string[] }
  | { kind: "unsupported"; why: string };

export function readInline(raw: string): Inline {
  const v = raw.trim().replace(/^&[\w-]+\s*/, ""); // an anchor on the value is fine
  if (v === "") return { kind: "empty" };
  if (v.startsWith("*")) return { kind: "unsupported", why: `YAML alias ${v.split(/\s/)[0]}` };
  if (v.startsWith("{")) return { kind: "unsupported", why: "flow mapping {…}" };
  if (v.startsWith("[")) {
    if (!v.endsWith("]")) return { kind: "unsupported", why: "unterminated flow sequence" };
    const inner = v.slice(1, -1);
    const items: string[] = [];
    let cur = "";
    let quote: string | undefined;
    for (const ch of inner) {
      if (quote) {
        if (ch === quote) quote = undefined;
        else if (ch === "," || ch === "[" || ch === "]" || ch === "{" || ch === "}") {
          return { kind: "unsupported", why: "flow sequence with a comma or bracket inside quotes" };
        }
        cur += ch;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        cur += ch;
      } else if (ch === "[" || ch === "]" || ch === "{" || ch === "}") {
        return { kind: "unsupported", why: "nested flow collection" };
      } else if (ch === ",") {
        items.push(unquote(cur));
        cur = "";
      } else cur += ch;
    }
    if (quote) return { kind: "unsupported", why: "unterminated quote in a flow sequence" };
    if (cur.trim() !== "" || items.length) items.push(unquote(cur));
    return { kind: "seq", items: items.filter((x) => x !== "") };
  }
  return { kind: "scalar", value: unquote(v) };
}

/**
 * The items of a block (`key:` followed by `- …` lines, or a supported flow
 * sequence). Each item is either a scalar or a mapping read with blocksAt().
 * Undefined when the value uses an unsupported form.
 */
type SeqItem = { scalar?: string; keys: Block[] };
function seqOf(b: Block | undefined): { items: SeqItem[] } | { unsupported: string } {
  if (!b) return { items: [] };
  const inl = readInline(b.inline);
  if (inl.kind === "unsupported") return { unsupported: inl.why };
  if (inl.kind === "seq") return { items: inl.items.map((x) => ({ scalar: x, keys: [] })) };
  if (inl.kind === "scalar") return { items: [{ scalar: inl.value, keys: [] }] };
  const out: SeqItem[] = [];
  let ind: number | undefined;
  let cur: string[] | undefined;
  const flush = () => {
    if (!cur || ind === undefined) return;
    const first = cur[0]!.slice(ind + 2);
    const keyed = /^(["']?)[^\s"'#-][^"']*?\1\s*:(\s|$)/.test(first);
    out.push(keyed ? { keys: blocksAt(cur, ind + 2) } : { scalar: unquote(first), keys: [] });
  };
  for (const l of b.body) {
    if (blank(l)) continue;
    const t = l.trimStart();
    if (ind === undefined && (t.startsWith("- ") || t === "-")) ind = indentOf(l);
    if (ind !== undefined && indentOf(l) === ind && (t.startsWith("- ") || t === "-")) {
      flush();
      cur = [" ".repeat(ind + 2) + t.slice(1).trimStart()];
      continue;
    }
    if (cur) cur.push(l);
    else return { unsupported: "a mapping where a sequence was expected" };
  }
  flush();
  return { items: out };
}

const keyOf = (keys: Block[], k: string): Block | undefined => keys.find((x) => x.key === k);

/** Absolute line range [start, end) of a direct child key of a top-level-or-nested block. */
function childRange(b: Block, key: string, bodyOffset: number): { start: number; end: number } | undefined {
  const ind = childIndent(b.body);
  if (ind === undefined) return undefined;
  const c = blocksAt(b.body, ind).find((x) => x.key === key);
  return c ? { start: bodyOffset + c.start, end: bodyOffset + c.end } : undefined;
}

/** First line in [start, end) whose text matches `re`. */
type Matcher = { test(line: string): boolean };
function firstLine(lines: string[], range: { start: number; end: number } | undefined, re: Matcher): number | undefined {
  if (!range) return undefined;
  for (let i = range.start; i < range.end; i++) if (re.test(lines[i]!)) return i;
  return undefined;
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
  /** Whether the job can run at all is not established (and why). */
  enabledUnknown?: string;
  manualOnly: boolean;
  /** Inherits from something this splitter does not follow. */
  inherits: boolean;
  mergeRequestGate: boolean | undefined;
  scheduled: boolean | undefined;
  /** Why a value above was left undefined. */
  why: Partial<Record<"mergeRequestGate" | "scheduled", string>>;
  /** 0-based line of the construct behind each true value, inside the job. */
  at: Partial<Record<"command" | "mergeRequestGate" | "scheduled" | Setting, number>>;
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

/**
 * One GitLab rule, read structurally. This does not model GitLab's rule
 * evaluator: it records only what decides a gate without evaluation.
 */
interface GitlabRule {
  /** No `if`, no `changes`, no `exists`: the rule matches every pipeline. */
  unconditional: boolean;
  /** The source named by a plain `$CI_PIPELINE_SOURCE == "<source>"` test, else undefined. */
  plainSource?: string;
  restricted: boolean; // has changes: or exists:
  when: string;
  allowFailure: "true" | "false" | "other" | undefined;
}

const PLAIN_SOURCE = /^\$CI_PIPELINE_SOURCE\s*==\s*["']([a-z_]+)["']$/;

function gitlabRule(item: SeqItem): GitlabRule | undefined {
  if (item.scalar !== undefined) return undefined;
  const ifB = keyOf(item.keys, "if");
  const ifInl = ifB ? readInline(ifB.inline) : undefined;
  if (ifB && (ifInl?.kind !== "scalar" || ifB.body.some((l) => !blank(l)))) return undefined;
  const whenB = keyOf(item.keys, "when");
  const whenInl = whenB ? readInline(whenB.inline) : undefined;
  if (whenB && whenInl?.kind !== "scalar") return undefined;
  const af = keyOf(item.keys, "allow_failure");
  const afInl = af ? readInline(af.inline) : undefined;
  const changes = Boolean(keyOf(item.keys, "changes"));
  const exists = Boolean(keyOf(item.keys, "exists"));
  const cond = ifInl?.kind === "scalar" ? ifInl.value : undefined;
  return {
    unconditional: !ifB && !changes && !exists,
    plainSource: cond !== undefined ? PLAIN_SOURCE.exec(cond)?.[1] : undefined,
    restricted: changes || exists,
    when: whenInl?.kind === "scalar" ? whenInl.value : "on_success",
    allowFailure: !af ? undefined : afInl?.kind === "scalar" ? (afInl.value === "true" ? "true" : afInl.value === "false" ? "false" : "other") : "other",
  };
}

/**
 * Decide a pipeline-source gate from a job's rules without evaluating them:
 * only when exactly one rule can apply to pipelines of `source`, and that rule
 * is a plain `$CI_PIPELINE_SOURCE == "<source>"` test with no changes/exists.
 * A rule that tests another source plainly cannot apply; any other rule can.
 * Rules after the first unconditional one are never reached.
 */
function gateFromRules(rules: GitlabRule[], source: string): { value?: boolean; why?: string } {
  const candidates: GitlabRule[] = [];
  for (const r of rules) {
    if (r.plainSource !== undefined && r.plainSource !== source && !r.restricted) continue;
    candidates.push(r);
    if (r.unconditional) break;
  }
  if (candidates.length !== 1) {
    return { why: `${candidates.length} rules can apply to ${source} pipelines; the outcome depends on rule evaluation, which is not modelled` };
  }
  const r = candidates[0]!;
  if (r.plainSource !== source) return { why: `the rule that can apply to ${source} pipelines is not a plain $CI_PIPELINE_SOURCE == "${source}" test` };
  if (r.restricted) return { why: `the ${source} rule is restricted by changes: or exists:` };
  if (r.when === "never" || r.when === "manual") return { value: false };
  if (r.allowFailure === "true") return { value: false };
  if (r.allowFailure === "other") return { why: "the rule's allow_failure is not a plain boolean" };
  return { value: true };
}

function parseGitlab(path: string, src: string): ParsedFile {
  const lines = stripYamlComments(src).split(/\r?\n/);
  const top = blocksAt(lines, 0);
  const workflow = top.find((x) => x.key === "workflow");
  const topWorkflowRules = workflow ? Boolean(child(workflow, "rules")) : false;
  const jobs: Job[] = [];
  for (const b of top) {
    if (GITLAB_RESERVED.has(b.key)) continue;
    const scripts = ["before_script", "script"].map((k) => textOf(child(b, k))).join("\n");
    const text = textOf(b);
    const why: Job["why"] = {};
    const whenB = child(b, "when");
    const whenInl = whenB ? readInline(whenB.inline) : undefined;
    const whenJob = whenInl?.kind === "scalar" ? whenInl.value : "";
    const afB = child(b, "allow_failure");
    const afInl = afB ? readInline(afB.inline) : undefined;
    const allowFailure: GitlabRule["allowFailure"] = !afB
      ? undefined
      : afInl?.kind === "scalar" && afB.body.every(blank)
        ? afInl.value === "true"
          ? "true"
          : afInl.value === "false"
            ? "false"
            : "other"
        : "other";
    const hidden = b.key.startsWith(".");
    const extendsB = child(b, "extends");
    const inherits = Boolean(extendsB) || /<<\s*:|!reference/.test(text) || /:\s+\*[\w-]+\s*$/m.test(text);
    const inheritWhy = extendsB
      ? `the job uses extends: ${extendsB.inline || "(list)"}, which can set when, rules and allow_failure`
      : /<<\s*:/.test(text)
        ? "the job merges a YAML anchor (<<:)"
        : /!reference/.test(text)
          ? "the job uses !reference"
          : "the job takes a value from a YAML alias (*name)";

    const rulesB = child(b, "rules");
    const rulesSeq = seqOf(rulesB);
    let rules: GitlabRule[] | undefined;
    let rulesWhy: string | undefined;
    if ("unsupported" in rulesSeq) rulesWhy = `rules: uses an unsupported form (${rulesSeq.unsupported})`;
    else {
      const parsed = rulesSeq.items.map(gitlabRule);
      if (parsed.some((r) => r === undefined)) rulesWhy = "a rule uses an unsupported form";
      else rules = parsed as GitlabRule[];
    }
    const onlyB = child(b, "only");
    const exceptB = child(b, "except");

    let disabled = hidden || whenJob === "never";
    let manualOnly = whenJob === "manual";
    let enabledUnknown: string | undefined;
    if (rules && rules.length) {
      const first = rules[0]!;
      if (first.unconditional) {
        // The first rule matches every pipeline; later rules are never reached.
        disabled = disabled || first.when === "never";
        manualOnly = manualOnly || first.when === "manual";
      } else {
        disabled = disabled || rules.every((r) => r.when === "never");
        const live = rules.filter((r) => r.when !== "never");
        manualOnly = manualOnly || (live.length > 0 && live.every((r) => r.when === "manual"));
      }
    }
    if (!disabled && inherits) enabledUnknown = inheritWhy;
    else if (!disabled && rulesWhy) enabledUnknown = rulesWhy;
    else if (!disabled && whenB && whenInl?.kind !== "scalar") enabledUnknown = "when: uses an unsupported form";
    if (enabledUnknown) manualOnly = false;

    let mergeRequestGate: boolean | undefined;
    let scheduled: boolean | undefined;
    if (enabledUnknown) {
      why.mergeRequestGate = why.scheduled = enabledUnknown;
    } else if (manualOnly || allowFailure === "true") {
      mergeRequestGate = false;
    } else if (allowFailure === "other") {
      why.mergeRequestGate = "allow_failure is not a plain boolean (exit_codes or a mapping)";
    } else if (topWorkflowRules) {
      why.mergeRequestGate = "the file has workflow: rules, which decide whether merge-request pipelines exist; they are not modelled";
    } else if (rules && rules.length) {
      const g = gateFromRules(rules, "merge_request_event");
      mergeRequestGate = g.value;
      if (g.why) why.mergeRequestGate = g.why;
    } else if (onlyB || exceptB) {
      const onlySeq = seqOf(onlyB);
      if (exceptB) why.mergeRequestGate = "except: is not modelled";
      else if ("unsupported" in onlySeq || onlySeq.items.some((i) => i.scalar === undefined)) {
        why.mergeRequestGate = "only: uses refs/variables/changes or an unsupported form";
      } else mergeRequestGate = onlySeq.items.some((i) => i.scalar === "merge_requests") ? true : undefined;
      if (mergeRequestGate === undefined && !why.mergeRequestGate) why.mergeRequestGate = "only: does not list merge_requests";
    } else {
      why.mergeRequestGate = "the job has no rules or only:; whether it runs in merge-request pipelines depends on settings outside the file";
    }

    if (!enabledUnknown) {
      if (rules && rules.length) {
        const g = gateFromRules(rules, "schedule");
        scheduled = g.value === undefined ? undefined : g.value;
        if (g.why) why.scheduled = g.why;
      } else if (onlyB && !exceptB) {
        const onlySeq = seqOf(onlyB);
        if (!("unsupported" in onlySeq) && onlySeq.items.some((i) => i.scalar === "schedules")) scheduled = true;
        else why.scheduled = "only: does not list schedules";
      } else {
        why.scheduled = "GitLab schedules are configured outside the YAML";
      }
    }

    const at: Job["at"] = {};
    const off = b.start + 1;
    for (const k of ["script", "before_script"]) {
      at.command ??= firstLine(lines, childRange(b, k, off), E2E_LINE);
    }
    if (mergeRequestGate) {
      at.mergeRequestGate = rules?.length
        ? firstLine(lines, childRange(b, "rules", off), /merge_request_event/)
        : firstLine(lines, childRange(b, "only", off), /merge_requests/);
    }
    if (scheduled) {
      at.scheduled = rules?.length ? firstLine(lines, childRange(b, "rules", off), /["']schedule["']/) : firstLine(lines, childRange(b, "only", off), /schedules/);
    }
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
      enabledUnknown,
      manualOnly,
      inherits,
      mergeRequestGate,
      scheduled,
      why,
      at,
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
        why: {},
        at: { command: firstLine(lines, { start: offset + b.start, end: offset + b.end }, E2E_LINE) },
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

/** For every true value, the file, job and 1-based line that carries it. */
function evidenceOf(jobs: Job[]): { evidence?: Record<string, { file: string; job: string; line: number }> } {
  const ev: Record<string, { file: string; job: string; line: number }> = {};
  const put = (field: string, key: keyof Job["at"], pick: (j: Job) => boolean) => {
    const j = jobs.find((x) => pick(x) && x.at[key] !== undefined);
    if (j) ev[field] = { file: j.file, job: j.name, line: j.at[key]! + 1 };
  };
  put("e2eJobPresent", "command", () => true);
  put("runsOnMergeRequest", "mergeRequestGate", (j) => j.mergeRequestGate === true);
  put("scheduledRun", "scheduled", (j) => j.scheduled === true);
  return Object.keys(ev).length ? { evidence: ev } : {};
}

/** The first reason given for each gate left undefined across the E2E jobs. */
function reasonsOf(jobs: Job[]): { reasons?: Record<string, string> } {
  const reasons: Record<string, string> = {};
  const gate = anyOf(jobs.map((j) => j.mergeRequestGate));
  const sched = anyOf(jobs.map((j) => j.scheduled));
  const mr = jobs.find((j) => j.why.mergeRequestGate)?.why.mergeRequestGate;
  const sc = jobs.find((j) => j.why.scheduled)?.why.scheduled;
  if (gate === undefined && mr) reasons.runsOnMergeRequest = mr;
  if (sched === undefined && sc) reasons.scheduledRun = sc;
  return Object.keys(reasons).length ? { reasons } : {};
}

/** Any true → true; all false → false; otherwise not established. */
function anyOf(values: Array<boolean | undefined>): boolean | undefined {
  if (values.some((v) => v === true)) return true;
  if (values.length > 0 && values.every((v) => v === false)) return false;
  return undefined;
}

/** The CI provider named by a set of CI file paths. */
export function ciProvider(paths: string[]): CiObservation["provider"] {
  if (paths.length === 0) return "none";
  if (paths.some((p) => basename(p) === ".gitlab-ci.yml")) return "gitlab";
  if (paths.some((p) => p.includes(".github/workflows"))) return "github";
  return "other";
}

/**
 * Downgrade a CI observation when some CI files were found but not read: an
 * observed absence (`false`) is no longer established, since the unread file
 * may hold the setting or the E2E job itself.
 */
export function withUnreadCiFiles(ci: CiObservation, allPaths: string[], unread: Array<{ path: string; kind: string }>): CiObservation {
  if (unread.length === 0) return ci;
  const list = unread.map((u) => `${u.path} (${u.kind})`).join(", ");
  const out: CiObservation = { ...ci, provider: ciProvider(allPaths), files: allPaths };
  for (const k of ["runsOnMergeRequest", "scheduledRun", "artifactsPublished", "junitReportWired", "parallelOrSharded", "blanketJobRetry", "dependencyCache"] as const) {
    if (out[k] === false) delete out[k];
  }
  if (!out.e2eJobPresent) out.e2eJobNotEstablished = `CI file(s) not read: ${list}`;
  return out;
}

export function analyseCi(files: Array<{ path: string; source: string }>): CiObservation {
  if (files.length === 0) {
    return { provider: "none", files: [], e2eJobPresent: false };
  }
  const provider = ciProvider(files.map((f) => f.path));
  const parsed = files.map((f) => (f.path.includes(".github/workflows") ? parseGithub(f.path, f.source) : parseGitlab(f.path, f.source)));

  const e2e: Array<{ job: Job; file: ParsedFile }> = [];
  let unknownJob: Job | undefined;
  for (const file of parsed) {
    for (const job of file.jobs) {
      if (job.disabled || !E2E_RUN_COMMAND.some((re) => re.test(job.commands))) continue;
      if (job.enabledUnknown) unknownJob ??= job;
      else e2e.push({ job, file });
    }
  }
  const base = { provider, files: files.map((f) => f.path) } as const;

  if (e2e.length === 0 && unknownJob) {
    return {
      ...base,
      e2eJobPresent: false,
      e2eJobNotEstablished: `job ${unknownJob.name} in ${unknownJob.file} runs an E2E command, but whether it runs is not established: ${unknownJob.enabledUnknown}`,
    };
  }
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
    ...reasonsOf(e2e.map(({ job }) => job)),
    ...evidenceOf(e2e.map(({ job }) => job)),
    artifactsPublished: per("artifacts"),
    junitReportWired: per("junit"),
    parallelOrSharded: per("parallel"),
    blanketJobRetry: per("retry"),
    dependencyCache: per("cache"),
  };
}
