import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerRunPlaywrightTest } from "./tools/runPlaywrightTest.js";
import { registerRunCypressTest } from "./tools/runCypressTest.js";
import { registerReadTestReport } from "./tools/readTestReport.js";

import { registerTestStrategy } from "./resources/testStrategy.js";
import { registerPlaywrightGuidelines } from "./resources/playwrightGuidelines.js";

import { registerGeneratePlaywrightTest } from "./prompts/generatePlaywrightTest.js";
import { registerAnalyzeTestFailure } from "./prompts/analyzeTestFailure.js";

import { registerTriageFlakyTest } from "./capabilities/flaky-test-triage/tool.js";
import { registerFlakyTestTriagePrompt } from "./capabilities/flaky-test-triage/prompts/flakyTestTriage.js";
import { registerAuditTestSuite } from "./capabilities/test-suite-audit/tool.js";
import { registerAssessTestStrategy } from "./capabilities/test-strategy-assessment/tool.js";
import { registerAuditRubric } from "./resources/auditRubric.js";
import { registerQaAuditPrompt } from "./prompts/qaAudit.js";

/**
 * Build the QA MCP server and register all capabilities.
 *
 * This file is intentionally thin: it only wires up tools, resources, and
 * prompts. All behaviour lives in its own module. Adding a capability means
 * adding a file and one register call here.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "qa-mcp-server",
    version: "0.1.0",
  });

  // Tools (controlled QA actions).
  registerRunPlaywrightTest(server);
  registerRunCypressTest(server);
  registerReadTestReport(server);

  // Capabilities (executable QA expertise — judgment, not data).
  registerTriageFlakyTest(server);
  registerAuditTestSuite(server);
  registerAssessTestStrategy(server);

  // Resources (reference material an agent can read).
  registerTestStrategy(server);
  registerPlaywrightGuidelines(server);
  registerAuditRubric(server);

  // Prompts (reusable QA workflows).
  registerGeneratePlaywrightTest(server);
  registerAnalyzeTestFailure(server);
  registerFlakyTestTriagePrompt(server);
  registerQaAuditPrompt(server);

  return server;
}
