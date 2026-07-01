import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const PLAYWRIGHT_GUIDELINES_MARKDOWN = `# Playwright Testing Guidelines

Conventions for writing reliable, maintainable Playwright tests.

## Selectors

- Prefer user-facing, accessible locators:
  \`getByRole\`, \`getByLabel\`, \`getByText\`, \`getByPlaceholder\`.
- Use \`data-testid\` only when a semantic locator is not practical.
- Avoid brittle CSS/XPath tied to layout or styling.

## Waiting and assertions

- Never use fixed sleeps (\`page.waitForTimeout\`) to synchronise.
- Rely on Playwright's web-first, auto-retrying assertions:
  \`await expect(locator).toBeVisible()\`, \`toHaveText\`, \`toHaveURL\`.
- Assert on observable state, not internals.

## Structure

- One user journey per test; keep tests independent.
- Use \`test.beforeEach\` for shared setup, fixtures for shared context.
- Group related tests with \`test.describe\`.
- Name tests by behaviour: \`"logs in with valid credentials"\`.

## Stability

- Seed or mock external dependencies for determinism.
- Use \`baseURL\` in config; keep tests environment-agnostic.
- Isolate state per test (fresh storage / auth context).

## Debugging & artifacts

- Enable \`trace: "on-first-retry"\` to capture failures without overhead.
- Capture screenshots and video on failure.
- Use \`npx playwright show-trace\` and the UI mode (\`--ui\`) to investigate.

## Example

\`\`\`ts
import { test, expect } from "@playwright/test";

test("logs in with valid credentials", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("user@example.com");
  await page.getByLabel("Password").fill("correct-horse");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
});
\`\`\`
`;

/**
 * Resource: qa://playwright-guidelines
 * Simple, practical Playwright authoring guidelines.
 */
export function registerPlaywrightGuidelines(server: McpServer): void {
  server.registerResource(
    "playwright-guidelines",
    "qa://playwright-guidelines",
    {
      title: "Playwright Guidelines",
      description: "Conventions for reliable, maintainable Playwright tests.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: PLAYWRIGHT_GUIDELINES_MARKDOWN,
        },
      ],
    }),
  );
}
