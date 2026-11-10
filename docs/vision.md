# Vision

## The problem has moved

Writing code is no longer the slow part of shipping software. AI assistants
generate features, fix bugs and open pull requests in minutes. What has not
sped up is knowing whether that code holds: whether the requirement is met,
whether the change breaks something else, whether a release is safe to ship,
whether an incident is a product bug or noise.

Quality is becoming the bottleneck. A team that ships ten times faster without
ten times more verification accumulates invisible debt until an incident makes
it visible. The test pyramid (unit, integration, API, end-to-end), test-driven
development and quality gates are not rituals. They are what makes speed
sustainable.

This project exists to keep quality from becoming the bottleneck.

## What a QA lead actually does

When a quality engineer joins a company, the work is not "run the tests". It is:

- connect to the company's inputs: requirements, tickets, source code,
  knowledge base, incidents, business rules;
- define a test strategy from them, prioritized P0 / P1 / P2;
- define the quality gates a change must pass before it ships;
- generate and maintain the tests that enforce those gates, API and
  end-to-end, with Playwright or Cypress or whatever the stack uses;
- judge: is this failure flaky or a regression, is this release ready, is this
  customer issue a real bug;
- investigate incidents and feed what was learned back into the strategy.

That is the job this project models. Not a test runner with an AI wrapper, but
the judgment of an experienced quality engineer, made available to agents.

## The thesis

An AI agent can do this job, on one condition: it must receive three things
that nobody gives it by default.

1. **A method.** How to prioritize, how to judge a flaky test, when a release
   is ready, what a quality gate is. Expertise encoded as explicit rules and
   reasoning, not left to the model's mood.
2. **Deterministic guardrails.** What the agent may never do on its own,
   whatever it is told: target production, purge data, hide a regression
   behind a retry or a weakened assertion. Enforced in code, not in a prompt.
3. **A trace.** Every judgment with its evidence, every run with a receipt,
   every held action with who released it and when. Observable, replayable,
   evaluable.

Not more intelligence. Method, limits and memory.

## What this project is

An open-source Model Context Protocol server that exposes the QA lead's job as
typed, testable capabilities. Each capability takes a structured observation
and returns a **structured judgment with evidence**, never raw data and never
an unsupported opinion.

Today the server runs tests, reads reports and triages flaky failures. The
direction is the full job: `define_test_strategy`, `assess_release`,
`validate_ticket`, `review_merge_request`, `investigate_incident`, built on
four primitives that every capability shares:

- a **journal** of runs and receipts (observability);
- an **approval gate** for sensitive actions, released only by a code that
  comes from outside the system (guardrail);
- **evals** that measure the server's own judgment, including its
  non-determinism (quality of the quality tool);
- **delegation** contracts, so a run can happen elsewhere, in CI or in a cloud
  session, and come back with a verifiable receipt.

The server is one layer in a three-layer design, and the only one this
repository owns:

| Layer | What it holds | Where it lives |
| --- | --- | --- |
| 1. Capabilities and primitives | The expertise, the guardrails, the trace | This repository, `src/` |
| 2. Method as skills | How to chain capabilities for a strategy, a release, an incident | This repository, as skill and agent instructions, not server code |
| 3. Orchestration | Which agent does what, where, with which worker | The harness (Claude Code, Codex, a cloud session, CI); this repository only documents reference setups |

Keeping orchestration out of the server is deliberate: harnesses improve every
few months, and a server that exposes capabilities benefits from every
improvement, while a home-made agent framework competes with them.

## Design principles

- **Deterministic first.** A rule, a schema, an allowlist or a validator before
  a model. The model where it adds judgment that code cannot encode.
- **Judgment, not data.** A capability that returns the input's numbers back
  is a connector. A capability of this project returns an assessment with
  confidence, evidence and actions.
- **Guardrails in code, not in prompts.** An instruction can be ignored,
  forgotten or injected around. A gate cannot.
- **Inputs are data, not instructions.** Tool parameters, report contents,
  ticket text and incident logs all come from untrusted sources, including
  the model itself.
- **Everything observable and replayable.** A run that cannot be replayed
  cannot be debugged, and an agent that cannot be debugged cannot be trusted.
- **The model is optional.** The server runs offline, without an API key. That
  keeps it usable anywhere, including in training settings where cost and
  connectivity matter.
- **Capabilities first, frameworks later.** No agent framework, workflow
  engine or abstraction layer until repeated, real needs justify it.

## Who it is for

- Companies that ship fast and whose quality practice has not kept up: many
  applications, AI-generated features, proofs of concept that must become
  reliable products.
- Quality engineers who want to make the jump from running tests to leading
  quality with agents, and who need a concrete, safe foundation to learn on.

## What it is not

- Not a replacement for quality engineers: a multiplier of their judgment.
- Not a platform or a web UI: a server you connect to the harness you already
  use.
- Not a generic terminal, but not a ban on terminals either. An agent may have
  a whole machine when that machine has walls: a sandbox, an egress
  allowlist, an approval gate. The walls are the point, not the absence of a
  shell.

## Where it comes from

This project grew out of hands-on quality engineering work on a production
product, where defining strategy, gates and release readiness was the daily
job, and out of a learning journey on agentic systems in which every concept
(MCP, sandboxing, delegation, guardrails, evals) was first built here before
being written about. The repository keeps both roles: a useful server, and a
living laboratory for agentic quality engineering.
