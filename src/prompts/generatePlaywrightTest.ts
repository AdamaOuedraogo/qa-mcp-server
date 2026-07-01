import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Prompt: generate-playwright-test
 *
 * A reusable prompt that guides an LLM to generate a Playwright test from a
 * user story, business rules, and existing conventions.
 */
export function registerGeneratePlaywrightTest(server: McpServer): void {
  server.registerPrompt(
    "generate-playwright-test",
    {
      title: "Generate Playwright Test",
      description:
        "Generate a Playwright test from a user story, business rules, and " +
        "existing project conventions.",
      argsSchema: {
        userStory: z
          .string()
          .describe("The user story or feature description to test."),
        businessRules: z
          .string()
          .optional()
          .describe("Business rules, acceptance criteria, or edge cases."),
        conventions: z
          .string()
          .optional()
          .describe("Existing project conventions (selectors, fixtures, helpers)."),
      },
    },
    ({ userStory, businessRules, conventions }) => {
      const text = [
        "You are a senior QA automation engineer writing Playwright tests in TypeScript.",
        "",
        "Generate a Playwright test that covers the following user story.",
        "",
        "## User story",
        userStory,
        "",
        "## Business rules and acceptance criteria",
        businessRules?.trim() || "(none provided — infer sensible, minimal criteria)",
        "",
        "## Project conventions to follow",
        conventions?.trim() ||
          "(none provided — follow Playwright best practices: role-based " +
            "locators, web-first assertions, no fixed timeouts, independent tests)",
        "",
        "## Requirements",
        "- Use `@playwright/test` with TypeScript.",
        "- Prefer accessible locators (getByRole, getByLabel, getByText).",
        "- Use web-first, auto-retrying assertions (expect(...).toBeVisible(), etc.).",
        "- No fixed sleeps. Keep the test independent and deterministic.",
        "- Cover the happy path and at least one important edge case.",
        "- Add a short comment explaining the intent of each test.",
        "",
        "Return only the test file contents in a single TypeScript code block.",
      ].join("\n");

      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text },
          },
        ],
      };
    },
  );
}
