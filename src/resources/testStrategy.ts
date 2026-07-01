import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const TEST_STRATEGY_MARKDOWN = `# Test Strategy

A pragmatic, layered strategy for a modern web application. Adapt the ratios to
your product's risk profile — this is a starting point, not a mandate.

## 1. Testing pyramid

- **Unit tests** — fast, isolated, cover business logic and edge cases. The
  largest layer.
- **Integration / component tests** — verify modules work together (API + DB,
  component + state). Medium size.
- **End-to-end tests (Playwright / Cypress)** — cover critical user journeys
  only. The smallest, most expensive layer. Keep them stable and few.

## 2. What to test end-to-end

Prioritise flows where a failure is expensive:

- Authentication and authorization
- Checkout / payment / core conversion flow
- Data-critical operations (create, update, delete of key entities)
- Anything with a history of production incidents

## 3. Principles

- **Test behaviour, not implementation.** Assert on what the user sees.
- **Deterministic tests.** No reliance on real time, random data, or network
  you don't control. Mock or seed instead.
- **Independent tests.** Each test sets up and tears down its own state.
- **Clear failure messages.** A failing test should point to the cause.
- **Fast feedback.** Keep the critical suite runnable in minutes on CI.

## 4. Environments

- Run unit/integration on every commit.
- Run the E2E critical suite on every pull request.
- Run the full E2E suite on a schedule and before release.

## 5. Reporting

- Emit machine-readable reports (JSON / JUnit) for CI and for AI-assisted
  analysis.
- Capture traces, screenshots, and videos on failure to speed up triage.
`;

/**
 * Resource: qa://test-strategy
 * A simple, opinionated markdown test strategy an agent can reference.
 */
export function registerTestStrategy(server: McpServer): void {
  server.registerResource(
    "test-strategy",
    "qa://test-strategy",
    {
      title: "QA Test Strategy",
      description: "A pragmatic, layered test strategy in Markdown.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: TEST_STRATEGY_MARKDOWN,
        },
      ],
    }),
  );
}
