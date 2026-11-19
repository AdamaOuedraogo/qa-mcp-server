import { basename } from "node:path";
import type { CiObservation } from "./schema.js";

/**
 * CI analysis: GitLab and GitHub Actions files in, a CiObservation out.
 *
 * No YAML parser (no new dependency): files are split into jobs by
 * indentation, conservatively. The principle (docs/reasoning.md): a CI
 * behaviour is stated only with structural and semantic evidence; otherwise
 * it is undefined with a reason. An abstention is for a construct this file
 * does not support, never a cover for misreading one it does.
 *
 *   A setting counts for the E2E job only when it sits in the job that runs
 *   the command. It is `false` only when the construct that would carry it
 *   was fully read and does not carry it. Present elsewhere (another job,
 *   `default:`, a template), inherited (`extends:`, `<<:`, `!reference`, an
 *   alias, a reusable workflow, a local action) or in an unsupported form, it
 *   is not established.
 *
 * The run command must sit in a job's `script:`/`before_script:` (GitLab) or
 * be the direct `run` / `uses: cypress-io/github-action` of an item of
 * `jobs.<job>.steps` (GitHub), in command position.
 *
 * A disabled job (`when: never`, `if: false`, a hidden `.template`) is not an
 * E2E job. A manual-only job, or one allowed to fail, is not a merge-request
 * gate. GitLab rules are read, not evaluated.
 */

/**
 * Run commands, matched in command position only: the start of a logical
 * command (a line, or after `&&`, `||`, `;`), past `VAR=value` assignments.
 * `--list`, `--help` and `--version` run no tests.
 */
const DIRECT_RUN =
  /^(?:(?:npx|bunx|pnpm\s+(?:exec|dlx)|pnpm|yarn\s+dlx|yarn|bun\s+x)\s+)?(?:\S*\/)?(?:playwright\s+test|cypress\s+run)(?=\s|$)(.*)$/i;
/** A package script recognised by its name only: the script body is not read, so the match is inferred. */
const SCRIPT_RUN = /^(?:npm\s+run(?:-script)?|pnpm(?:\s+run)?|yarn(?:\s+run)?|bun\s+run)\s+((?:test:)?e2e(?::[\w-]+)?)(?=\s|$)/i;
const NOT_A_RUN = /(?:^|\s)(?:--list|--help|-h|--version|-V)(?=\s|$|=)/;
/** Loose mention, used only to explain an abstention, never to claim a job. */
const MENTION = /\b(?:playwright\s+test|cypress\s+run|test:e2e)\b/i;

export type CommandBasis = "observed" | "inferred";

/** Split shell text into logical commands: backslash continuations joined, then lines and &&, ||, ; */
function logicalCommands(text: string): string[] {
  return text
    .replace(/\\\r?\n\s*/g, " ")
    .split(/\r?\n|&&|\|\||;/)
    .map((c) => c.trim().replace(/^-\s+/, "").replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "").trim())
    .filter(Boolean);
}

/** The strongest run command in a script or run block: observed (direct), inferred (script name) or none. */
export function commandBasis(text: string): CommandBasis | undefined {
  let best: CommandBasis | undefined;
  for (const c of logicalCommands(text)) {
    const d = DIRECT_RUN.exec(c);
    if (d && !NOT_A_RUN.test(d[1] ?? "")) return "observed";
    if (SCRIPT_RUN.test(c)) best = "inferred";
  }
  return best;
}

/** A direct E2E command that shards or parallelises the run itself. */
const SHARD_ARG = /(?:^|\s)--shard(?:=|\s)\S+|(?:^|\s)cypress\s+run\b.*\s--parallel\b/;

/**
 * Sharding of the E2E run, from its command and the job's concurrency:
 * true with a shard argument; false only for a direct command with neither
 * a shard argument nor concurrency; otherwise not established.
 */
function shardingOf(commands: string, basis: CommandBasis | undefined, concurrency: string | undefined): { value?: boolean; why?: string } {
  if (logicalCommands(commands).some((c) => SHARD_ARG.test(" " + c))) return { value: true };
  if (basis !== "observed") return { why: "the E2E command is a package script whose body was not read" };
  if (concurrency) return { why: `${concurrency} without a shard argument in the E2E command; the runner may read the node index itself` };
  return { value: false };
}

/** A line that holds a run command. */
const E2E_LINE: Matcher = {
  test: (l: string) => {
    const v = stripYamlComments(l).replace(/^\s*(?:-\s+)?(?:[\w-]+\s*:\s*)?/, "");
    const inl = readInline(v);
    const parts = inl.kind === "seq" ? inl.items : inl.kind === "scalar" ? [inl.value] : [v];
    return parts.some((x) => commandBasis(x) !== undefined);
  },
};

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
    .map((l) => {
      let quote: string | undefined;
      for (let i = 0; i < l.length; i++) {
        const ch = l[i]!;
        if (quote) {
          if (ch === quote) quote = undefined;
        } else if (ch === '"' || ch === "'") {
          // An apostrophe inside a word (don't) is not a quote.
          if (ch === "'" && i > 0 && /\w/.test(l[i - 1]!)) continue;
          quote = ch;
        } else if (ch === "#" && (i === 0 || /\s/.test(l[i - 1]!))) {
          return l.slice(0, i).trimEnd();
        }
      }
      // Unbalanced quotes: fall back to cutting at the first " #", the cautious reading.
      return quote ? l.replace(/(^|\s)#.*$/, "") : l;
    })
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
  /** How the job's E2E command was recognised, if it has one. */
  basis?: CommandBasis;
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
  /** A setting whose carrier was not fully read, and why: never false. */
  unread: Partial<Record<Setting, string>>;
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
    const scripts = ["before_script", "script"]
      .map((k) => {
        const c = child(b, k);
        if (!c) return "";
        const inl = readInline(c.inline);
        const head = inl.kind === "seq" ? inl.items.join("\n") : inl.kind === "scalar" ? inl.value : "";
        return [head, ...c.body].join("\n");
      })
      .join("\n");
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
    at.artifacts = childRange(b, "artifacts", off)?.start;
    at.junit = firstLine(lines, childRange(b, "artifacts", off), /^\s*junit\s*:/);
    at.parallel = firstLine(lines, childRange(b, "script", off), /--shard|--parallel/) ?? childRange(b, "parallel", off)?.start;
    at.retry = childRange(b, "retry", off)?.start;
    at.cache = childRange(b, "cache", off)?.start;
    const unread: Job["unread"] = {};
    const settings: Job["settings"] = { artifacts: false, junit: false, parallel: false, retry: false, cache: false };

    const artB = child(b, "artifacts");
    if (artB) {
      settings.artifacts = true;
      const artInl = readInline(artB.inline);
      if (artInl.kind !== "empty") unread.junit = `artifacts: uses an unsupported form (${artInl.kind === "unsupported" ? artInl.why : "inline value"})`;
      else {
        const reports = child(artB, "reports");
        const repInl = reports ? readInline(reports.inline) : undefined;
        if (reports && repInl?.kind !== "empty") unread.junit = "artifacts:reports uses an unsupported form";
        else settings.junit = Boolean(reports && child(reports, "junit"));
      }
    }

    const par = child(b, "parallel");
    const sh = shardingOf(scripts, commandBasis(scripts), par ? `parallel: ${par.inline || "matrix"}` : undefined);
    if (sh.value) settings.parallel = true;
    else if (sh.why) unread.parallel = sh.why;

    const retryB = child(b, "retry");
    if (retryB) {
      const inl = readInline(retryB.inline);
      if (inl.kind === "scalar") settings.retry = /^[12]$/.test(inl.value);
      else if (inl.kind === "empty") {
        const max = child(retryB, "max");
        const maxV = max ? readInline(max.inline) : undefined;
        const whenB = child(retryB, "when");
        const whenSeq = seqOf(whenB);
        if (maxV?.kind !== "scalar" || "unsupported" in whenSeq) unread.retry = "retry: uses an unsupported form";
        else {
          const whens = whenSeq.items.map((i) => i.scalar ?? "");
          const onTestFailure = !whenB || whens.includes("always") || whens.includes("script_failure");
          settings.retry = /^[12]$/.test(maxV.value) && onTestFailure;
        }
      } else unread.retry = `retry: uses an unsupported form (${inl.kind === "unsupported" ? inl.why : "sequence"})`;
    }

    const cacheB = child(b, "cache");
    if (cacheB) {
      const inl = readInline(cacheB.inline);
      if (inl.kind === "empty") settings.cache = true;
      else if (inl.kind === "seq") settings.cache = inl.items.length > 0;
      else unread.cache = `cache: uses an unsupported form (${inl.kind === "unsupported" ? inl.why : "scalar"})`;
    }

    jobs.push({
      file: path,
      name: b.key,
      commands: scripts,
      basis: commandBasis(scripts),
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
      unread,
      settings,
    });
  }
  return { path, lines, jobs, includesOthers: top.some((b) => b.key === "include") };
}

// --- GitHub Actions -------------------------------------------------------------

/** One item of `jobs.<job>.steps`, read by its direct keys only. */
interface Step {
  run?: string;
  /** 0-based line of the run command (the line that holds it in a block scalar). */
  runLine?: number;
  uses?: string;
  usesLine?: number;
  if?: string;
  continueOnError: boolean;
  with: Block[];
}

/** Actions whose effect on the settings below is known; any other action is not read. */
const KNOWN_ACTIONS = /^(actions\/(checkout|setup-node|setup-python|setup-java|setup-go|cache|upload-artifact|download-artifact)|pnpm\/action-setup|oven-sh\/setup-bun|cypress-io\/github-action|dorny\/test-reporter|mikepenz\/action-junit-report|EnricoMi\/publish-unit-test-result-action|nick-fields\/retry|Wandalen\/wretry\.action)@/;
const JUNIT_ACTIONS = /^(dorny\/test-reporter|mikepenz\/action-junit-report|EnricoMi\/publish-unit-test-result-action)@/;
const RETRY_ACTIONS = /^(nick-fields\/retry|Wandalen\/wretry\.action)@/;

/** The value of a `run:` key: a scalar, or a literal (|) / folded (>) block scalar. */
function runValue(b: Block, absStart: number): { text: string; lines: number[] } | undefined {
  const inl = b.inline;
  if (/^[|>][-+]?$/.test(inl)) {
    const body = b.body.filter((l) => !blank(l));
    const ind = body.length ? indentOf(body[0]!) : 0;
    const rows = b.body.map((l, i) => ({ t: l.slice(ind), at: absStart + 1 + i })).filter((r) => r.t.trim() !== "");
    return { text: rows.map((r) => r.t).join(inl.startsWith(">") ? " " : "\n"), lines: rows.map((r) => r.at) };
  }
  const v = readInline(inl);
  if (v.kind !== "scalar") return undefined;
  return { text: v.value, lines: [absStart] };
}

/** The items of `jobs.<job>.steps`, each read by its direct keys; undefined when steps are not a block sequence. */
function stepsOf(lines: string[], range: { start: number; end: number } | undefined): Step[] | { unsupported: string } {
  if (!range) return [];
  const head = lines[range.start]!;
  const inl = readInline(head.replace(/^\s*steps\s*:/, ""));
  if (inl.kind !== "empty") return { unsupported: inl.kind === "unsupported" ? inl.why : "steps: is not a block sequence" };
  const steps: Step[] = [];
  let itemIndent: number | undefined;
  const starts: number[] = [];
  for (let i = range.start + 1; i < range.end; i++) {
    const l = lines[i]!;
    if (blank(l)) continue;
    const t = l.trimStart();
    if (itemIndent === undefined && t.startsWith("-")) itemIndent = indentOf(l);
    if (indentOf(l) === itemIndent && (t.startsWith("- ") || t === "-")) starts.push(i);
  }
  if (itemIndent === undefined) return [];
  starts.forEach((s0, k) => {
    const e0 = k + 1 < starts.length ? starts[k + 1]! : range.end;
    const raw = lines.slice(s0, e0);
    const item = [" ".repeat(itemIndent! + 2) + raw[0]!.trimStart().slice(1).trimStart(), ...raw.slice(1)];
    const keys = blocksAt(item, itemIndent! + 2);
    const step: Step = { continueOnError: false, with: [] };
    for (const kb of keys) {
      const abs = s0 + kb.start;
      if (kb.key === "run") {
        const v = runValue(kb, abs);
        if (v) {
          step.run = v.text;
          step.runLine = v.lines.find((n) => E2E_LINE.test(lines[n]!)) ?? v.lines[0];
        }
      } else if (kb.key === "uses") {
        const v = readInline(kb.inline);
        if (v.kind === "scalar") {
          step.uses = v.value;
          step.usesLine = abs;
        }
      } else if (kb.key === "if") {
        const v = readInline(kb.inline);
        step.if = v.kind === "scalar" ? v.value : "(unsupported form)";
      } else if (kb.key === "continue-on-error") {
        const v = readInline(kb.inline);
        step.continueOnError = v.kind === "scalar" && v.value === "true";
      } else if (kb.key === "with") {
        const ind = childIndent(kb.body);
        step.with = ind === undefined ? [] : blocksAt(kb.body, ind);
      }
    }
    steps.push(step);
  });
  return steps;
}

const STEP_DISABLED = /^(false|\$\{\{\s*false\s*\}\})$/;

function parseGithub(path: string, src: string): ParsedFile {
  const lines = stripYamlComments(src).split(/\r?\n/);
  const top = blocksAt(lines, 0);
  const on = top.find((b) => ["on", "true"].includes(b.key));
  // Triggers are the keys of on: (a scalar, a flow sequence or a block
  // mapping); words inside a trigger's options are not triggers.
  const triggers = new Set<string>();
  const triggerBlocks = new Map<string, Block>();
  let triggersWhy: string | undefined = on ? undefined : "the workflow has no on: key";
  if (on) {
    const inl = readInline(on.inline);
    if (inl.kind === "scalar") triggers.add(inl.value);
    else if (inl.kind === "seq") inl.items.forEach((t) => triggers.add(t));
    else if (inl.kind === "unsupported") triggersWhy = `on: uses an unsupported form (${inl.why})`;
    else {
      const ind = childIndent(on.body);
      for (const t of ind === undefined ? [] : blocksAt(on.body, ind)) {
        triggers.add(t.key);
        triggerBlocks.set(t.key, t);
      }
    }
  }
  const triggersRead = triggersWhy === undefined;
  // A pull_request trigger gates merges unless its types exclude the events a
  // PR update raises; a paths filter makes it conditional.
  let prGate: boolean | undefined = false;
  let prWhy: string | undefined;
  for (const name of ["pull_request", "pull_request_target"]) {
    if (!triggers.has(name)) continue;
    const tb = triggerBlocks.get(name);
    const types = tb ? child(tb, "types") : undefined;
    const typesSeq = seqOf(types);
    if (tb && (child(tb, "paths") || child(tb, "paths-ignore"))) {
      prGate = undefined;
      prWhy = `${name} has a paths filter, so it runs only for some changes`;
    } else if ("unsupported" in typesSeq) {
      prGate = undefined;
      prWhy = `${name}.types uses an unsupported form`;
    } else if (types && !typesSeq.items.some((i) => ["opened", "synchronize", "reopened"].includes(i.scalar ?? ""))) {
      // runs on other PR events only (closed, labeled…): not a gate
    } else if (prGate === false) prGate = true;
  }
  if (triggers.has("merge_group")) prGate = true;
  const prTrigger = prGate;
  const manualFile = triggersRead && triggers.size > 0 && [...triggers].every((t) => t === "workflow_dispatch");
  const calledElsewhere = triggers.has("workflow_call");

  const jobsBlock = top.find((b) => b.key === "jobs");
  const jobs: Job[] = [];
  let includesOthers = false;
  if (jobsBlock) {
    const ind = childIndent(jobsBlock.body);
    const offset = jobsBlock.start + 1;
    for (const b of ind === undefined ? [] : blocksAt(jobsBlock.body, ind)) {
      const text = textOf(b);
      const jobOff = offset + b.start + 1;
      const stepsRead = stepsOf(lines, childRange(b, "steps", jobOff));
      const steps = Array.isArray(stepsRead) ? stepsRead : [];
      const live = steps.filter((st) => !(st.if !== undefined && STEP_DISABLED.test(st.if)));
      const isCommand = (st: Step) =>
        (st.run !== undefined && commandBasis(st.run) !== undefined) || (st.uses !== undefined && /^cypress-io\/github-action@/.test(st.uses));
      const commandSteps = live.filter(isCommand);
      const commands = commandSteps.map((st) => st.run ?? `uses: ${st.uses}`).join("\n");
      const jobIf = unquote(child(b, "if")?.inline ?? "");
      const reusable = Boolean(child(b, "uses"));
      if (reusable) includesOthers = true;
      const disabled = /^(false|\$\{\{\s*false\s*\}\})$/.test(jobIf);
      const continueOnError = /^true$/.test(unquote(child(b, "continue-on-error")?.inline ?? ""));
      const manualOnly = !disabled && manualFile;

      const why: Job["why"] = {};
      const stepIf = commandSteps.length > 0 && commandSteps.every((st) => st.if !== undefined);
      const stepContinue = commandSteps.length > 0 && commandSteps.every((st) => st.continueOnError);
      let mergeRequestGate: boolean | undefined;
      let scheduled: boolean | undefined;
      if (manualOnly || continueOnError || stepContinue) mergeRequestGate = false;
      else if (stepIf) why.mergeRequestGate = why.scheduled = "the E2E step has its own if:";
      else if (!triggersRead) why.mergeRequestGate = triggersWhy;
      else if (jobIf) why.mergeRequestGate = "the job has its own if:";
      else if (calledElsewhere) why.mergeRequestGate = "the workflow is reusable (workflow_call); its callers decide";
      else if (prTrigger === undefined) why.mergeRequestGate = prWhy;
      else if (prTrigger) mergeRequestGate = true;
      else if (triggers.has("pull_request") || triggers.has("pull_request_target")) mergeRequestGate = false;
      else why.mergeRequestGate = "the workflow has no pull_request trigger; whether its checks gate merges is set outside the file";

      if (stepIf) {
        // reason already set above
      } else if (!triggersRead) why.scheduled = triggersWhy;
      else if (jobIf) why.scheduled = "the job has its own if:";
      else if (calledElsewhere) why.scheduled = "the workflow is reusable (workflow_call); its callers decide";
      else scheduled = triggers.has("schedule");

      // A setting carried by steps is false only when every step was read.
      const unknownAction = steps.find((st) => st.uses !== undefined && !st.uses.startsWith("./") && !KNOWN_ACTIONS.test(st.uses));
      const unread: Job["unread"] = {};
      if (!Array.isArray(stepsRead)) {
        for (const k of ["artifacts", "junit", "retry", "cache", "parallel"] as const) unread[k] = `steps: uses an unsupported form (${stepsRead.unsupported})`;
      } else if (unknownAction) {
        for (const k of ["artifacts", "junit", "retry", "cache"] as const) unread[k] = `step uses ${unknownAction.uses}, which is not read`;
      }
      unread.junit ??= "GitHub has no built-in test report; only a known JUnit reporter action establishes it";
      const firstUses = (re: RegExp) => steps.find((st) => st.uses !== undefined && re.test(st.uses));
      const withCache = steps.find((st) => {
        const c = keyOf(st.with, "cache");
        const v = c ? readInline(c.inline) : undefined;
        return v?.kind === "scalar" && v.value !== "" && v.value !== "false";
      });
      const cyParallel = steps.find((st) => {
        const v = keyOf(st.with, "parallel");
        const r = v ? readInline(v.inline) : undefined;
        return st.uses !== undefined && /^cypress-io\/github-action@/.test(st.uses) && r?.kind === "scalar" && r.value === "true";
      });
      const matrix = /^\s*matrix\s*:/m.test(textOf(child(b, "strategy")));
      const runText = commandSteps.map((st) => st.run ?? "").join("\n");
      const runBasis = commandSteps.some((st) => st.uses !== undefined) ? "observed" : commandBasis(runText);
      const ghShard = cyParallel ? { value: true } : shardingOf(runText, runBasis, matrix ? "strategy: matrix" : undefined);
      if (ghShard.why) unread.parallel ??= ghShard.why;
      const art = firstUses(/^actions\/upload-artifact@/);
      const junit = firstUses(JUNIT_ACTIONS);
      const retry = firstUses(RETRY_ACTIONS);
      const cache = firstUses(/^actions\/cache@/) ?? withCache;
      const onRange = on ? { start: on.start, end: on.end } : undefined;
      const at: Job["at"] = {
        command: commandSteps[0]?.runLine ?? commandSteps[0]?.usesLine,
        // A GitHub gate is set by the workflow trigger, so its evidence is the trigger line in on:.
        mergeRequestGate: mergeRequestGate
          ? firstLine(lines, onRange, { test: (l) => /^\s*(on|"on"|'on')\s*:\s*\S/.test(l) ? /\b(pull_request|pull_request_target|merge_group)\b/.test(l) : /^\s*(pull_request|pull_request_target|merge_group)\s*:/.test(l) })
          : undefined,
        scheduled: scheduled
          ? firstLine(lines, onRange, { test: (l) => /^\s*(on|"on"|'on')\s*:\s*\S/.test(l) ? /\bschedule\b/.test(l) : /^\s*schedule\s*:/.test(l) })
          : undefined,
        artifacts: art?.usesLine,
        junit: junit?.usesLine,
        retry: retry?.usesLine,
        cache: cache?.usesLine,
        parallel: cyParallel?.usesLine ?? (ghShard.value ? commandSteps.find((st) => /--shard|--parallel/.test(st.run ?? ""))?.runLine : undefined),
      };

      jobs.push({
        file: path,
        name: b.key,
        commands,
        basis: commandSteps.some((st) => st.uses !== undefined && /^cypress-io\/github-action@/.test(st.uses))
          ? "observed"
          : commandSteps.reduce<CommandBasis | undefined>((acc, st) => (acc === "observed" ? acc : (commandBasis(st.run ?? "") ?? acc)), undefined),
        text,
        start: offset + b.start,
        end: offset + b.end,
        disabled,
        manualOnly,
        inherits: reusable || steps.some((st) => st.uses?.startsWith("./")),
        mergeRequestGate,
        scheduled,
        why,
        at,
        unread,
        settings: {
          artifacts: Boolean(art),
          junit: Boolean(junit),
          parallel: ghShard.value === true,
          retry: Boolean(retry),
          cache: Boolean(cache),
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

/** True / false / not established (with the reason) for one setting of one E2E job. */
function settingFor(job: Job, file: ParsedFile, s: Setting): { value?: boolean; why?: string } {
  if (job.settings[s]) return { value: true };
  if (job.unread[s]) return { why: job.unread[s] };
  if (job.inherits) return { why: "the job inherits from a template, a reusable workflow or a local action that was not read" };
  const elsewhere = [...file.lines.slice(0, job.start), ...file.lines.slice(job.end)].join("\n");
  return SETTING_ELSEWHERE[s].test(elsewhere) ? { why: "the setting appears elsewhere in the file, not in the E2E job" } : { value: false };
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
      if (job.disabled || job.basis === undefined) continue;
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
    const textHit = parsed.find((p) => MENTION.test(p.lines.join("\n")));
    const inherits = parsed.find((p) => p.includesOthers || p.jobs.some((j) => j.inherits && !j.disabled));
    const reason = textHit
      ? `an E2E command appears in ${textHit.path} outside any enabled job's own script (variables, a template, an extended or disabled job)`
      : inherits
        ? `${inherits.path} pulls jobs or steps from elsewhere (include, extends, a reusable workflow or a local action) that were not read`
        : undefined;
    return { ...base, e2eJobPresent: false, ...(reason ? { e2eJobNotEstablished: reason } : {}) };
  }

  const settingReasons: Record<string, string> = {};
  const settingEvidence: Record<string, { file: string; job: string; line: number }> = {};
  const per = (s: Setting, field: string) => {
    const each = e2e.map(({ job, file }) => ({ job, r: settingFor(job, file, s) }));
    const v = anyOf(each.map((x) => x.r.value));
    if (v === undefined) {
      const w = each.find((x) => x.r.why)?.r.why;
      if (w) settingReasons[field] = w;
    }
    if (v === true) {
      const hit = each.find((x) => x.r.value === true && x.job.at[s] !== undefined);
      if (hit) settingEvidence[field] = { file: hit.job.file, job: hit.job.name, line: hit.job.at[s]! + 1 };
    }
    return v;
  };
  const settings = {
    artifactsPublished: per("artifacts", "artifactsPublished"),
    junitReportWired: per("junit", "junitReportWired"),
    parallelOrSharded: per("parallel", "parallelOrSharded"),
    blanketJobRetry: per("retry", "blanketJobRetry"),
    dependencyCache: per("cache", "dependencyCache"),
  };
  const gates = reasonsOf(e2e.map(({ job }) => job)).reasons ?? {};
  const ev = evidenceOf(e2e.map(({ job }) => job)).evidence ?? {};
  const reasons = { ...gates, ...settingReasons };
  const evidence = { ...ev, ...settingEvidence };
  return {
    ...base,
    e2eJobPresent: true,
    e2eJobs: e2e.map(({ job }) => ({
      file: job.file,
      job: job.name,
      manualOnly: job.manualOnly,
      basis: job.basis ?? "observed",
    })),
    runsOnMergeRequest: anyOf(e2e.map(({ job }) => job.mergeRequestGate)),
    scheduledRun: anyOf(e2e.map(({ job }) => job.scheduled)),
    ...settings,
    ...(Object.keys(reasons).length ? { reasons } : {}),
    ...(Object.keys(evidence).length ? { evidence } : {}),
  };
}
