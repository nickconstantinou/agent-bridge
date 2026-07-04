# Shared Runtime Architecture

## Status

Canonical architecture documentation.

## Purpose

The Shared Runtime provides common services consumed by both the Companion Runtime and the Engineering Worker.

It prevents duplication while keeping product-specific domain models separate.

## Responsibilities

Shared Runtime may provide:

- provider / CLI selection
- CLI process invocation seams
- session persistence boundaries
- SQLite persistence helpers
- event and audit records
- memory access seams
- notifications
- metrics and health checks
- authentication and authorization seams
- secrets access seams
- capability registry
- diagnostics

## Dependency Direction

```text
Companion Runtime ─┐
                   ├── Shared Runtime
Engineering Worker ┘
```

Shared Runtime must not depend on Companion Runtime or Engineering Worker internals.

Product-specific concepts must remain outside Shared Runtime unless they are represented as neutral interfaces or metadata.

## Boundary Rules

Shared Runtime may know about:

- providers
- capabilities
- sessions
- notifications
- diagnostics
- generic policy metadata

Shared Runtime must not own:

- Telegram-specific conversational command behavior
- Discord-specific conversational command behavior
- worker work item lifecycles
- TDD phases
- GitHub PR state machines
- merge approval state machines

## Epic 11 Scope

Epic 11 should introduce only small shared seams:

- minimal capability registry
- shared provider/fallback abstractions
- doctor diagnostic plumbing
- tests for scope and fallback behavior

It should not perform a broad directory move or service rename.
