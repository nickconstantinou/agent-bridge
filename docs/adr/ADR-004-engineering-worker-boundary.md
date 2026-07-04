# ADR-004 — Keep Engineering Worker Software-Engineering-Only

## Status

Accepted.

## Context

Agent Bridge can support broad conversational AI use cases through the Companion Runtime, but the Engineering Worker has a narrower and more valuable mission: autonomous software engineering with human-controlled merge and destructive-operation gates.

Adding general-purpose research, writing, browser, or chat-agent concepts directly to the worker would dilute its safety model and make implementation harder to reason about.

## Decision

The Engineering Worker remains software-engineering-only.

It owns repository work, planning, TDD, verification, PR lifecycle, CI reaction, review repair, and merge approvals.

It may consume Shared Runtime capabilities, but only through explicit worker policies and scope checks.

## Consequences

Positive:

- preserves the worker's unique value
- keeps safety and approval rules clear
- prevents general capability sprawl
- keeps external project influence in the correct layer

Trade-offs:

- some user-facing requests may need to route through Companion Runtime first
- worker feature requests must be evaluated against the engineering-only boundary

## Implementation Guidance

Worker code should not import or depend on Companion Runtime transport behavior.

Companion Runtime code should not import worker domain models except through explicit command/API boundaries.
