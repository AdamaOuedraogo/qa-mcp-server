# Roadmap

This project follows a simple philosophy: **build → learn what is needed →
document → publish what was actually built.** The roadmap is a direction, not a
promise. Scope is kept deliberately small, and the order follows the
dependencies: you cannot evaluate what you do not observe, nor gate what you
do not journal.

## Completed milestones

What is already in place as of v0.1 and the first part of v0.2:

- Foundation project created, official MCP SDK, TypeScript + Node.js + pnpm
- Controlled QA tools (`run_playwright_test`, `run_cypress_test`, `read_test_report`)
- Resources (`qa://test-strategy`, `qa://playwright-guidelines`)
- Prompts (`generate-playwright-test`, `analyze-test-failure`, `flaky-test-triage`)
- Safe command-execution utility (allowlist, no shell, timeout, output cap)
- Opt-in real execution pinned to one project directory, through a single
  execution adapter
- First judgment capability: `triage_flaky_test` (pure, deterministic, tested)
- Report adapters: Playwright JSON, Mochawesome, JUnit XML (internal)
- Documentation (README, Vision, Architecture, Contributing, AGENTS.md, KEEP.md)
- Execution-boundary tests; `read_test_report` confined to the project directory
  with a bounded read; test output and reports returned as untrusted data

## v0.2 — Real execution (opt-in), remaining items

- [x] Confine `read_test_report` to `QA_MCP_PROJECT_DIR`, with symlink
      handling, bounded reads and tests
      ([issue #7](https://github.com/AdamaOuedraogo/qa-mcp-server/issues/7))
- [x] Wrap report contents and captured test output as untrusted data
      (delimiters, one-line notice) before they reach the model
- [x] Tests for the execution boundary (`runCommand`, `runInProject`:
      allowlist, path traversal, timeout, output cap, no `node -e` /
      `pnpm exec` escape through any registered tool)
- [ ] Structured parsing of Playwright/Cypress results into typed output

## v0.3 — Primitives

Four building blocks every later capability shares, plus the evidence schema
they consume. Deterministic code, no model required. None of this exists yet.

- [ ] **Journal and receipts**: a `run_id` per tool call; JSONL events per run
      (`started`, `output`, `exit`, `timeout`); a `read_run` tool. A receipt
      records:
      - the **canonical artifact hash**: the report normalized (stable key
        order, trimmed volatile fields such as durations and absolute paths)
        before hashing, with the algorithm and the normalization version named
        in the receipt, so the same run hashes the same everywhere;
      - the commit, the environment name and the timestamp;
      - the **execution identity**: who or what produced the run (the local
        runner under the server's user, a CI job and runner id, or a delegated
        session) and the trust boundary it ran inside;
      - the `run_id` and a reference to the journal entries.

      **Verification semantics**: a receipt verifies when the artifact
      re-hashes to the recorded value under the recorded normalization and
      the execution identity is one the operator's policy trusts. A receipt
      that does not verify is recorded but is not evidence for a release
      judgment. Cryptographic signing of receipts is optional and comes later;
      the first version relies on the journal and the operator's trust in the
      identity.
- [ ] **Approval gate**: operator policy per action (`free` / `gated`),
      `production` gated by default; a held action returns a `hold_id`, pings
      a channel (ntfy first), and executes only after a code that comes from
      outside the system and passes a strict validator; one release per hold;
      codes found inside inputs are refused and journaled
- [ ] **Evals**: an `evals/` folder of cases (input, expected judgment,
      constraints) for the triage rules and the policy; a `pnpm eval` runner
      that replays N times and reports pass@1 and pass^k; an optional
      model-graded judge for prompts only where no deterministic check exists
- [ ] **Delegation**: a `RUN.md` brief (commit, environment, suite, expected
      format, way home); a `run_remote` tool that triggers a run elsewhere
      (GitHub Actions first), polls with a deadline and a heartbeat, and brings
      back report + receipt; a `compare_runs(local, remote)` capability that
      aligns results by test name and commit
- [ ] **Normalized observation and evidence schema (versioned)**, the
      prerequisite of every v0.4 capability: a `zod` schema with a version
      field that describes what a judgment may look at: the change (diff and
      files touched), the requirements or acceptance criteria, CI status and
      runs, provenance (where each item came from, retrieved by whom and
      when) and artifact links (reports, receipts, logs). The harness
      retrieves the evidence (layer 3); the server normalizes it into this
      schema and judges it (layer 1), and never fetches from a ticket or code
      host on its own. For the first end-to-end case, a minimal GitHub adapter
      (pull request diff and check status) or harness-provided input is
      enough; a full connector suite stays in the exploratory list.
- [ ] Optional container sandbox for live mode (compose + egress allowlist
      proxy), documented as a reference setup

## v0.4 — The QA lead's capabilities

The job itself, built on the primitives and on the versioned evidence schema
from v0.3, which is a prerequisite: no v0.4 capability takes free-form input.
Each returns a structured judgment with evidence.

- [ ] `define_test_strategy` — from requirements, code and knowledge base to a
      prioritized P0 / P1 / P2 strategy and the quality gates it implies
- [ ] `assess_release` — is this release ready to ship, against the gates,
      with the runs and receipts that prove it
- [ ] `validate_ticket` — is a ticket QA OK before production
- [ ] `review_merge_request` — testability, risk and coverage of a change
- [ ] `investigate_incident` — is a customer issue a real product bug, with
      the evidence trail
- [ ] Test generation: API and end-to-end tests (Playwright, Cypress) from
      acceptance criteria, enforcing the gates

## Later — exploratory

Only if they prove genuinely useful.

- [ ] Connectors for first-class inputs beyond the minimal GitHub adapter:
      Jira, GitLab, incident and log platforms, knowledge bases
- [ ] RAG over test suites, docs and past failures
- [ ] Additional frameworks (Vitest, Jest, k6)
- [ ] Trace/screenshot ingestion for failure analysis
- [ ] Notifications beyond ntfy (Slack, email)

## Three layers

How the pieces fit together. This repository owns the first layer only.

| Layer | What it holds | Where it lives |
| --- | --- | --- |
| 1. Capabilities and primitives | The expertise, the guardrails, the trace | This repository, `src/` |
| 2. Method as skills | How to chain capabilities for a strategy, a release, an incident | This repository, as skill and agent instructions (`AGENTS.md` today; skill folders are not created yet), not server code |
| 3. Orchestration | Which agent does what, where, with which worker | The harness (Claude Code, Codex, a cloud session, CI); this repository only documents reference setups |

Orchestration stays out of the server on purpose: harnesses improve every few
months, and a capability server benefits from every improvement, while a
home-made agent framework competes with them. Multi-agent setups, LangGraph or
CrewAI workflows and reference QA agents are things people may build **on top
of** this server; they are not planned features of it.

> **Capabilities first. Frameworks later.**

## Explicit non-goals for now

- No generic terminal tool exposed to the model.
- No arbitrary shell execution from the LLM.
- No agent framework, workflow engine or orchestrator inside the server.
- No large platform or web UI.
- No model required to run the server.
