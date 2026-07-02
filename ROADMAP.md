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

- [ ] Opt-in real execution behind an explicit config flag / env var
- [ ] Working-directory restriction and project detection
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
