# ADR-001 — Split OSS into Companion Runtime and Engineering Worker

## Status

Accepted.

## Context

Agent Bridge contains two different product shapes:

1. conversational bots that route user prompts to AI runtimes, and
2. an autonomous software-engineering worker that manages work items, repositories, TDD, PRs, CI, and merge approvals.

Treating both as variations of one worker-centric system creates unclear boundaries and encourages unrelated features to leak between products.

## Decision

Agent Bridge OSS is split conceptually into:

- Companion Runtime — domain-agnostic conversational AI runtime
- Engineering Worker — software-engineering-only autonomous work engine
- Shared Runtime — common runtime services used by both

Existing service names and env files remain stable unless a future roadmap approves changes.

## Consequences

Positive:

- clearer architecture
- easier onboarding
- less accidental coupling
- better platform boundary
- safer evaluation of external projects

Trade-offs:

- documentation must distinguish legacy names from architectural terms
- future refactors need to preserve compatibility

## Implementation Guidance

Do not perform broad renames solely for terminology alignment.

Use the split to guide future seams, tests, and documentation.
