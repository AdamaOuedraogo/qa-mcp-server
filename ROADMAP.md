# Roadmap

This project follows a simple philosophy: **build → learn what is needed →
document → publish what was actually built.** The roadmap is a direction, not a
promise. Scope is kept deliberately small.

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

## Explicit non-goals for now

- No generic terminal tool.
- No arbitrary shell execution from the LLM.
- No large platform or web UI.
