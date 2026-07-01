# Vision

## What this is

`qa-mcp-server` is an open source [Model Context Protocol](https://modelcontextprotocol.io)
server dedicated to **Quality Engineering**. It gives AI agents a small, safe,
and well-typed surface to interact with real QA workflows: running tests,
reading reports, and reasoning about test design and failures.

## Why MCP for QA

MCP is a standard way for AI applications to connect to tools, data, and
reusable prompts. Instead of every assistant re-inventing ad-hoc integrations,
an MCP server exposes capabilities once and any MCP-compatible client can use
them.

Quality Engineering is a strong fit:

- QA work is full of **structured, repeatable actions** (run a suite, read a
  report, triage a failure) — good candidates for well-defined tools.
- QA depends on **shared conventions and knowledge** (test strategy, framework
  guidelines) — good candidates for resources.
- QA has **recurring reasoning tasks** (generate a test, analyze a failure) —
  good candidates for reusable prompts.

## Agentic Quality Engineering

Agentic Quality Engineering is the practice of letting AI agents participate in
the testing loop — proposing tests, running them, reading the results, and
suggesting fixes — under **human oversight and safe, controlled tools**.

The emphasis is on *controlled*. An agent should not have a generic terminal.
It should have narrow, auditable tools like `run_playwright_test` whose inputs
are typed and whose behaviour is predictable.

## Principles

- **Start small, stay clean.** A minimal foundation that is easy to extend.
- **Safety first.** No arbitrary shell execution. Allowlisted, bounded actions.
- **Separation of concerns.** Each tool, resource, and prompt in its own file;
  the server only wires them together.
- **Build → learn → document → publish.** Ship what is actually built.

## Non-goals (for now)

- No full autonomous agent.
- No RAG.
- No large platform or web UI.

These may come later — see the [roadmap](../ROADMAP.md).
