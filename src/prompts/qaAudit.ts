import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Prompt: qa-audit
 *
 * The "first days at a client" workflow. It frames the agent to run the audit
 * capabilities in order and to write the report in the engagement's shape
 * (Diagnose → Prototype → Adopt) — using the capabilities' judgments, not
 * improvised opinions.
 */
export function registerQaAuditPrompt(server: McpServer): void {
  server.registerPrompt(
    "qa-audit",
    {
      title: "QA Audit (suite + strategy)",
      description:
        "Audit a team's test suite and testing practice end to end, then write a consulting-grade " +
        "report with findings, evidence, maturity scores and a Diagnose → Prototype → Adopt plan.",
      argsSchema: {
        scope: z.string().optional().describe("What is in scope: repos, squads, products."),
        strategyNotes: z
          .string()
          .optional()
          .describe("Pasted strategy document, interview notes, CI observations — anything about the practice."),
        audience: z.string().optional().describe("Who reads the report: e.g. 'QA lead and tech leads', 'CTO'."),
      },
    },
    ({ scope, strategyNotes, audience }) => {
      const text = [
        "You are a senior Quality Engineering consultant on the first days of an engagement.",
        "Your job is to produce an audit the team can act on this week — not a lecture.",
        "",
        "Work in this order, and use the capabilities for every judgment:",
        "",
        "1. **Read the rubric** — resource `qa://audit-rubric` — so scores and severities mean the same thing to you and the team.",
        "2. **Audit the code** — call `audit_test_suite` (optionally with `path` for a sub-folder). Open the cited",
        "   evidence lines before quoting a finding; drop any that look like false positives and say so.",
        "3. **Audit the practice** — fill `assess_test_strategy` from the notes below and any documents you can read.",
        "   Answer `unknown` honestly; the capability turns unknowns into questions for the team.",
        "4. **Add run evidence if available** — recent CI reports: use `read_test_report` and `triage_flaky_test` on",
        "   retried or failing tests, so reliability findings carry real numbers.",
        "5. **Write the report** in this shape:",
        "   - Executive summary (5 lines): maturity, the three things that matter, what you propose.",
        "   - Findings by severity with file:line evidence and the recommendation (from the capabilities).",
        "   - Hotspot files to fix first.",
        "   - Diagnose → Prototype → Adopt plan: what you measure, what you fix in a first pull request,",
        "     what the team adopts (standards, policy, community of practice).",
        "   - Open questions for the team.",
        "   - Suggested next engagement (from `assess_test_strategy.services`).",
        "",
        "Rules: never recommend hiding a failure (no sleeps, no skips, no blanket retries, no weakened",
        "assertions). Prefer the smallest change that proves value. Keep the team's ownership explicit.",
        "",
        `## Scope\n${scope?.trim() || "(not provided — audit the configured project root)"}`,
        "",
        `## Audience\n${audience?.trim() || "QA lead and tech leads"}`,
        "",
        `## Notes about the practice\n${strategyNotes?.trim() || "(none — fill the questionnaire with 'unknown' and list the questions to ask)"}`,
      ].join("\n");
      return { messages: [{ role: "user", content: { type: "text", text } }] };
    },
  );
}
