# Vision

## Why this project exists

Software engineering is entering a new era.

AI assistants are rapidly becoming capable of generating code, reviewing pull requests, explaining bugs and helping developers throughout the software development lifecycle.

Quality Engineering is naturally the next discipline to benefit from this evolution.

However, today's AI integrations often rely on a generic terminal to interact with testing environments.

While powerful, a terminal exposes far more capabilities than a Quality Engineering workflow actually requires.

This project explores a different approach.

Instead of giving AI assistants unrestricted access to a machine, we believe they should receive carefully designed Quality Engineering capabilities.

The goal is not to make AI more powerful.

The goal is to make AI more useful.

---

# Vision

We believe AI agents will become valuable collaborators for Quality Engineers.

To reach that future, they need interfaces designed specifically for testing.

Not operating system privileges.

Not unrestricted shell access.

But focused capabilities such as:

* running automated tests;
* reading reports;
* analyzing failures;
* understanding testing strategies;
* accessing business rules;
* generating high-quality test cases;
* helping engineers investigate software quality.

QA MCP Server exists to explore what those capabilities should look like.

---

# Design Philosophy

Every capability exposed by this project should follow a few simple principles.

## Purpose-built capabilities

Expose Quality Engineering capabilities instead of generic system access.

A capability should solve a real QA problem.

---

## Safe by default

The safest behavior should always be the default behavior.

Potentially dangerous operations should require explicit design decisions and validation.

---

## Secure execution

AI capabilities should execute in the smallest, safest environment possible.

Potentially dangerous operations should be isolated from the host system whenever appropriate.

Security should be part of the architecture, not an afterthought.

---

## Small composable building blocks

Each Tool, Resource and Prompt should remain small, focused and reusable.

Complex workflows should emerge from combining simple capabilities rather than creating monolithic tools.

---

## Documentation before complexity

Architecture decisions should be documented before the project becomes difficult to understand.

Good documentation is considered part of the implementation.

---

## AI-friendly interfaces

Everything exposed by this project should be understandable by both humans and AI assistants.

Clarity is more valuable than cleverness.

---

# What this project is

QA MCP Server is:

* an open-source MCP server;
* a collection of Quality Engineering capabilities;
* a reference implementation for AI-assisted testing;
* a learning laboratory for Agentic Quality Engineering.

---

# What this project is not

This project is not:

* another AI coding assistant;
* another Playwright framework;
* another testing framework;
* a generic terminal wrapper;
* an autonomous QA platform.

The objective is not to replace Quality Engineers.

The objective is to augment them.

---

# From capabilities to workflows

qa-mcp-server is not just a wrapper around Cypress or Playwright.

> The long-term objective is not to expose testing tools. It is to expose
> Quality Engineering capabilities that mirror the real work of QA engineers.

Playwright and Cypress are execution details, not the center of the product. The
first-class inputs of Quality Engineering are Jira tickets, merge requests,
incidents, acceptance criteria, test strategy and business rules.

The low-level tools are building blocks. The long-term goal is to model real
Quality Engineering workflows as capabilities an AI agent can use — not to
replace QA engineers, but to model and augment their work.

We think in two layers.

## Layer 1 — Low-level QA capabilities

Small, typed, safe MCP capabilities that each read or do one concrete thing,
grouped by domain:

* Jira — tickets, acceptance criteria, business context
* GitLab — merge requests, pipelines
* Testing — Playwright and Cypress runs
* Knowledge — test strategy, business rules
* Reports — test results and artifacts
* Logs — Datadog and other observability

Examples: `read_jira_ticket`, `read_merge_request`, `read_pipeline_status`,
`run_playwright_test`, `run_cypress_test`, `read_test_report`,
`read_datadog_logs`, `read_test_strategy`, `read_business_rules`.

Today only a subset exists (the testing, reports and knowledge building blocks).
The rest are direction, not implemented.

## Layer 2 — QA workflows

Higher-level workflows that combine many Layer 1 capabilities to model how a QA
engineer actually works. They are modeled on real product QA practice.

### validate_ticket()

Decide whether a ticket can be marked "QA OK" before production. Consults the
Jira ticket and acceptance criteria, the merge request, the CI pipeline and the
P0 tests it already ran, the P1/P2 tests run on a staging or preview
environment, and the regression risk.

### review_merge_request()

A QA-focused review of a merge request: is it testable, risky, missing coverage,
or likely to break existing behavior? Inspects the MR description and code
changes, the related Jira ticket, test changes, pipeline status, and the
existing test strategy.

### investigate_incident()

Determine whether a customer-reported issue is a real product bug. May use the
Jira customer ticket, Datadog logs, customer context, reproduction steps,
related incidents, existing bugs, and test reports. The output helps decide
whether to open a bug for developers.

`validate_ticket`, `review_merge_request` and `investigate_incident` are **not
current MVP features**. They are long-term workflow targets built on top of
smaller capabilities, and they describe where the low-level capabilities are
heading. Capabilities first, workflows later.

---

# Long-term direction

The project will evolve incrementally.

Each new capability should answer a real problem encountered by Quality Engineers.

Future iterations may include:

* Playwright execution
* Cypress execution
* API testing
* trace analysis
* report analysis
* Jira integration
* GitHub integration
* Slack integration
* Quality knowledge resources
* RAG-powered documentation
* reference QA agents built on top of this server

Technology choices may evolve over time.

The vision should not.

---

# Decision rule

Every proposed feature should answer "yes" to at least one of these questions:

* Does it make AI assistants more useful for Quality Engineers?
* Does it improve safety?
* Does it improve clarity?
* Does it improve maintainability?
* Does it solve a real testing problem?

If the answer is "no" to all of them, it probably does not belong in this project.

---

# Agentic Quality Lab

QA MCP Server is the first project developed as part of **Agentic Quality Lab**.

Agentic Quality Lab is a long-term initiative dedicated to exploring how AI agents can transform Quality Engineering through practical experimentation, open-source software and transparent engineering.

The philosophy remains simple:

**Build → Learn → Share**

Every feature implemented in this repository is an opportunity to learn, document architectural decisions and share real engineering experience with the community.
