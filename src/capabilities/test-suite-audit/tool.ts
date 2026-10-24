import { z } from "zod";
import { isAbsolute, relative, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getExecutionConfig } from "../../config.js";
import { auditTestSuite } from "./evaluator.js";
import { scanProject } from "./scanner.js";
import { TestSuiteObservationSchema, type TestSuiteAuditJudgment, type TestSuiteObservation } from "./schema.js";

/**
 * Capability: audit_test_suite
 *
 * The "first day at a client" capability. It reads a Playwright/Cypress project
 * the way a senior QA consultant would — specs, config, CI, repo hygiene — and
 * returns an audit: maturity per axis, findings with file:line evidence, the
 * hotspot files to fix first, and a Diagnose → Prototype → Adopt action plan.
 *
 * Read-only by construction: it opens files, never runs anything. The audited
 * root is the operator's `QA_MCP_PROJECT_DIR` when set (falling back to the
 * server's working directory, like `read_test_report`). The caller may narrow
 * to a sub-directory but can never escape the root.
 *
 * Two ways in: let the server scan (`path`), or hand it an observation the
 * agent assembled itself (`observation`) when the server has no filesystem
 * access to the repository.
 */
export function registerAuditTestSuite(server: McpServer): void {
  server.registerTool(
    "audit_test_suite",
    {
      title: "Audit Test Suite",
      description:
        "Audit a Playwright/Cypress test suite the way a senior QA consultant would on day one: " +
        "maturity score per axis (reliability, maintainability, feedback speed, coverage & risk, " +
        "observability, governance), findings with file:line evidence, hotspot files to fix first, " +
        "and a Diagnose → Prototype → Adopt action plan. Static and read-only: it never executes tests. " +
        "Scans QA_MCP_PROJECT_DIR (or the server's cwd); pass `path` to narrow to a sub-folder, or " +
        "`observation` to audit a project the server cannot read.",
      inputSchema: {
        path: z
          .string()
          .max(512)
          .optional()
          .describe("Optional sub-folder of the audited root (relative, no '..'). Defaults to the root."),
        maxSpecFiles: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe("Cap on spec files to analyse (default 400)."),
        observation: TestSuiteObservationSchema.optional().describe(
          "A pre-assembled observation (same shape the scanner produces). When given, no file is read.",
        ),
      },
    },
    async ({ path, maxSpecFiles, observation }) => {
      try {
        let obs: TestSuiteObservation;
        let rootNote = "";
        if (observation) {
          obs = observation;
          rootNote = "Source: observation supplied by the caller (no files read).";
        } else {
          const root = getExecutionConfig().projectDir ?? process.cwd();
          const target = resolveInside(root, path);
          if (!target) {
            return refuse(`Refused: "${path}" is absolute or escapes the audited root. Use a relative sub-folder without '..'.`);
          }
          obs = await scanProject(target, { maxSpecFiles });
          rootNote = `Audited root: ${target}`;
        }
        const judgment = auditTestSuite(obs);
        return { content: [{ type: "text", text: render(judgment, rootNote) }] };
      } catch (err) {
        return refuse(`Audit failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

/**
 * Resolve `sub` under `root`; undefined if it is malformed, absolute or escapes.
 *
 * Malformed input (control characters, NUL, a Windows drive prefix) is
 * rejected outright rather than cleaned: a caller that sends `tests\u0000/..`
 * is not making a typo. This is a lexical check on the requested path — the
 * scanner additionally refuses to follow symlinks — not a filesystem sandbox.
 */
export function resolveInside(root: string, sub: string | undefined): string | undefined {
  const base = resolve(root);
  if (sub === undefined) return base;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(sub)) return undefined;
  const trimmed = sub.trim();
  if (trimmed === "" || trimmed === ".") return base;
  if (isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith("\\\\")) return undefined;
  if (trimmed.split(/[\\/]/).includes("..")) return undefined;
  const abs = resolve(base, trimmed);
  const rel = relative(base, abs);
  if (rel === "" ) return abs;
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return abs;
}

function refuse(text: string) {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

const SEVERITY_ICON = { critical: "🟥", high: "🟧", medium: "🟨", low: "🟩" } as const;

/** Render for humans; always append the machine-readable judgment for agents. */
export function render(j: TestSuiteAuditJudgment, rootNote: string): string {
  const lines: string[] = [
    `# Test Suite Audit`,
    "",
    `**${j.headline}**`,
    "",
    j.summary,
    "",
    rootNote,
    "",
    `**Scan completeness:** ${Math.round(j.completeness.score * 100)}% — ${j.completeness.specsAnalysed}/${j.completeness.specsFound} specs analysed, runner config ${j.completeness.runnerConfigFound ? "found" : "not found"}, CI ${j.completeness.ciDefinitionFound ? "found" : "not found"}, package.json ${j.completeness.packageJsonFound ? "found" : "not found"}.` +
      (j.completeness.notes.length ? ` Not judged: ${j.completeness.notes.join("; ")}.` : ""),
    "",
    "## Maturity by axis (0 absent · 1 ad hoc · 2 defined · 3 managed · 4 optimized)",
    "",
    "| Axis | Level | Why |",
    "| --- | --- | --- |",
    ...j.axes.map((a) => `| ${a.axis.replace(/_/g, " ")} | ${a.level} — ${a.label} | ${a.rationale} |`),
    "",
    `## Findings (${j.findings.length}; ${j.quickWinCount} quick wins ⚡)`,
    "",
  ];
  for (const f of j.findings) {
    lines.push(`### ${SEVERITY_ICON[f.severity]} ${f.id} · ${f.title}${f.quickWin ? " ⚡" : ""}`);
    lines.push(
      `- **Axis:** ${f.axis.replace(/_/g, " ")} · **Severity:** ${f.severity} · **Effort:** ${f.effort}` +
        (f.basis === "not_observed" ? " · **Basis:** not observed at the audited root — verify before reporting as absent" : ""),
    );
    lines.push(`- **Observed:** ${f.observation}`);
    lines.push(`- **Impact:** ${f.impact}`);
    lines.push(`- **Recommendation:** ${f.recommendation}`);
    if (f.evidence.length) {
      lines.push("- **Evidence:**");
      for (const e of f.evidence) {
        lines.push(`  - \`${e.file}${e.line ? ":" + e.line : ""}\`${e.snippet ? " — " + e.snippet : ""}`);
      }
    }
    lines.push("");
  }
  if (j.hotspots.length) {
    lines.push("## Hotspots — fix these files first", "");
    j.hotspots.forEach((h, i) => lines.push(`${i + 1}. \`${h.path}\` (score ${h.score}) — ${h.reasons.join(", ")}`));
    lines.push("");
  }
  lines.push("## Action plan — Diagnose → Prototype → Adopt", "");
  for (const phase of ["diagnose", "prototype", "adopt"] as const) {
    const items = j.actionPlan.filter((a) => a.phase === phase);
    if (!items.length) continue;
    lines.push(`### ${phase.charAt(0).toUpperCase() + phase.slice(1)}`);
    for (const a of items) {
      lines.push(`- _[${a.priority}, ${a.effort}]_ **${a.action}**`);
      lines.push(`  ${a.rationale}${a.findingIds.length ? ` (${a.findingIds.join(", ")})` : ""}`);
    }
    lines.push("");
  }
  lines.push("## Caveats", "", ...j.caveats.map((c) => `- ${c}`), "");
  lines.push("## Judgment (JSON)", "```json", JSON.stringify(j, null, 2), "```");
  return lines.join("\n");
}
