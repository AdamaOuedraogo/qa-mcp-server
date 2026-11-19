import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { assessTestStrategy } from "./evaluator.js";
import { TestStrategyObservationSchema, type TestStrategyJudgment } from "./schema.js";

/**
 * Capability: assess_test_strategy
 *
 * Judges a team's testing *practice* — strategy, prioritisation, ownership,
 * CI gate, flaky policy, community — from a typed questionnaire the agent
 * fills in from documents and interviews. Returns gaps with a 30/60/90-day
 * plan, the questions still to ask, and the service offers that answer the
 * gaps. Pure: no file or network access.
 */
export function registerAssessTestStrategy(server: McpServer): void {
  server.registerTool(
    "assess_test_strategy",
    {
      title: "Assess Test Strategy",
      description:
        "Assess a team's test strategy and automation practice (not its code): risk-based " +
        "prioritisation, test layers, ownership, standards, CI gate, flaky policy, reporting, " +
        "community of practice, AI usage. Fill the questionnaire from documents and interviews; " +
        "answer 'unknown' when you do not know — each unknown becomes a question to ask. Returns " +
        "maturity per axis, prioritised gaps, a 30/60/90-day plan, open questions and the service " +
        "offers that address the gaps. Pair it with audit_test_suite for the code-level view.",
      inputSchema: TestStrategyObservationSchema.shape,
    },
    async (input) => {
      try {
        const j = assessTestStrategy(input);
        return { content: [{ type: "text", text: render(j) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `Assessment failed: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  );
}

const ICON = { critical: "🟥", high: "🟧", medium: "🟨", low: "🟩" } as const;

export function render(j: TestStrategyJudgment): string {
  const lines: string[] = [
    "# Test Strategy & Practice Assessment",
    "",
    `**${j.headline}**`,
    "",
    j.summary,
    "",
    "## Maturity by axis",
    "",
    "| Axis | Level | Why |",
    "| --- | --- | --- |",
    ...j.axes.map((a) => `| ${a.axis.replace(/_/g, " ")} | ${a.level} — ${a.label} | ${a.rationale} |`),
    "",
    `## Gaps (${j.gaps.length})`,
    "",
  ];
  for (const g of j.gaps) {
    lines.push(`### ${ICON[g.severity]} ${g.id} · ${g.title}`);
    lines.push(`- **Axis:** ${g.axis.replace(/_/g, " ")} · **Severity:** ${g.severity} · **Horizon:** ${g.horizon.replace("_", " ")}`);
    lines.push(`- **Observed:** ${g.observation}`);
    lines.push(`- **Impact:** ${g.impact}`);
    lines.push(`- **Recommendation:** ${g.recommendation}`);
    lines.push("");
  }
  if (j.openQuestions.length) {
    lines.push("## Questions to ask the team", "");
    for (const q of j.openQuestions) lines.push(`- **${q.question}** _(${q.field})_ — ${q.whyItMatters}`);
    lines.push("");
  }
  lines.push("## 30 / 60 / 90-day plan", "");
  for (const h of ["30_days", "60_days", "90_days"] as const) {
    lines.push(`### ${h.replace("_", " ")}`);
    const items = j.plan[h];
    lines.push(...(items.length ? items.map((i) => `- ${i}`) : ["- (nothing scheduled)"]), "");
  }
  if (j.services.length) {
    lines.push("## Services that address these gaps", "");
    for (const s of j.services) lines.push(`- **${s.title}** → ${s.outcome} _(${s.gapIds.join(", ")})_`);
    lines.push("");
  }
  lines.push("## Judgment (JSON)", "```json", JSON.stringify(j, null, 2), "```");
  return lines.join("\n");
}
