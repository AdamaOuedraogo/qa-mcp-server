# Roadmap

This project follows a simple philosophy: **build → learn what is needed →
document → publish what was actually built.** The roadmap is a direction, not a
promise. Scope is kept deliberately small.

## Completed milestones

What is already in place as of v0.1:

- Foundation project created
- Official MCP SDK
- TypeScript + Node.js + pnpm
- Controlled QA tools (`run_playwright_test`, `run_cypress_test`, `read_test_report`)
- Resources (`qa://test-strategy`, `qa://playwright-guidelines`)
- Prompts (`generate-playwright-test`, `analyze-test-failure`)
- Safe command-execution utility (allowlist, no shell, timeout, output cap)
- Documentation (README, Vision, Architecture, Contributing)

## v0.1 — Foundation (current)

The clean, extensible MVP.

- [x] TypeScript + Node.js + pnpm project using the official MCP SDK
- [x] Controlled tools: `run_playwright_test`, `run_cypress_test`,
      `read_test_report`
- [x] Resources: `qa://test-strategy`, `qa://playwright-guidelines`
- [x] Prompts: `generate-playwright-test`, `analyze-test-failure`
- [x] Safe command-execution utility (allowlist, no shell, timeout, output cap)
- [x] Documentation: README, vision, architecture, contributing

## v0.2 — Real execution (opt-in)

Turn the dry-run tools into safe, real runners.

- [x] Opt-in real execution behind an explicit config flag / env var
      (`QA_MCP_EXECUTION_MODE`, `QA_MCP_PROJECT_DIR`)
- [x] Working-directory restriction (runs pinned to one configured project dir;
      `..` path traversal rejected) via a dedicated execution adapter
- [ ] Structured parsing of Playwright/Cypress results into typed output
- [ ] Basic tests for the command utility and tool handlers

## v0.3 — Richer reporting

- [ ] First-class Playwright JSON reporter parsing
- [ ] JUnit XML parsing
- [ ] Failure summarisation resource/tool built on real artifacts

## Later — exploratory

Only if they prove genuinely useful.

- [ ] RAG over test suites, docs, and past failures
- [ ] Additional frameworks (Vitest, Jest, k6)
- [ ] Trace/screenshot ingestion for `analyze-test-failure`
- [ ] Optional agent workflows on top of the tools

## Two layers: capabilities and workflows

A direction for how the pieces fit together — not a commitment to dates. See
[docs/vision.md](docs/vision.md) and [docs/architecture.md](docs/architecture.md).

**Layer 1 — low-level QA capabilities** (MCP tools/resources), grouped by
domain. Some exist; most are future:

- Jira — `read_jira_ticket` (acceptance criteria, business context)
- GitLab — `read_merge_request`, `read_pipeline_status`
- Testing — `run_playwright_test`, `run_cypress_test` — done
- Knowledge — `read_test_strategy`, `read_business_rules`
- Reports — `read_test_report` — done
- Logs — `read_datadog_logs`

**Layer 2 — QA workflows** that compose Layer 1 to model real QA work
(not implemented):

- `validate_ticket()` — decide whether a ticket is QA OK before production
- `review_merge_request()` — QA-focused MR review (testability, risk, coverage)
- `investigate_incident()` — decide whether a customer issue is a real product bug

Consistent with the philosophy below: build the small capabilities first; the
workflows only make sense once enough of them exist.

## Long-term vision

This repository focuses on building QA **capabilities**: small, safe, composable
tools, resources, and prompts.

Longer term, those capabilities could serve as the foundation that higher-level
AI systems build on. Possible directions include:

- Multi-agent QA systems
- LangGraph workflows
- CrewAI workflows
- Reference QA agents
- SDKs built on top of the server
- Reusable QA capability libraries

These are **not planned features**. They are directions that would only make
sense if real adoption and real needs pull the project there. The guiding rule
stays the same:

> **Capabilities first. Frameworks later.**

The current priority is unchanged: build small, safe, composable QA capabilities.

## Explicit non-goals for now

- No generic terminal tool.
- No arbitrary shell execution from the LLM.
- No large platform or web UI.
