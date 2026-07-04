# Agent Bridge Architecture Overview

## Status

Canonical architecture documentation.

This document describes the current intended system shape. It is not a roadmap and does not approve speculative research items for implementation.

## Mission

Agent Bridge is an open-source runtime for autonomous AI agents.

The OSS is composed of two products sharing one runtime foundation:

```text
Agent Bridge OSS
├── Companion Runtime
│   └── Domain-agnostic conversational AI runtime
├── Engineering Worker
│   └── Software-engineering-only autonomous work engine
└── Shared Runtime
    └── Common runtime services consumed by both
```

The hosted Agent Bridge Platform provisions, manages, upgrades, bills, and monitors deployments. Autonomous execution belongs to the OSS runtime.

## Architectural Principles

1. Keep conversational runtime concerns separate from engineering-worker concerns.
2. Share infrastructure through explicit runtime services rather than copy/paste implementations.
3. Preserve the existing service and environment compatibility unless a roadmap explicitly approves a breaking change.
4. Treat research documents as non-authoritative until promoted into an active roadmap.
5. Keep destructive operations and merge decisions behind explicit human approval.

## Product Split

### Companion Runtime

The Companion Runtime provides conversational access to AI runtimes through chat or future TUI surfaces.

It is domain agnostic. It should support research, summarisation, writing, translation, planning, explanation, and general tool use without inheriting engineering-worker concepts.

### Engineering Worker

The Engineering Worker is a software-engineering-only autonomous engine.

It owns repository work, work items, TDD implementation, PR lifecycle, CI reaction, review repair, and merge approval gates.

It is not a general chatbot or broad agent framework.

### Shared Runtime

The Shared Runtime contains common services that both products consume:

- provider / CLI selection
- SQLite persistence
- session boundaries
- memory access
- notifications
- metrics and health
- auth / authorization seams
- secrets access seams
- event and audit records
- capability registry
- diagnostics

## Documentation Hierarchy

Use documentation in this order:

1. `docs/adr/` — decisions that have been accepted.
2. `docs/architecture/` — current intended design.
3. `docs/roadmap/` — approved implementation work.
4. `docs/research/` — deferred ideas only.
5. `docs/archive/` — historical context only.

Implementation agents must not build from research or archive documents unless the idea has been promoted into an active roadmap.
