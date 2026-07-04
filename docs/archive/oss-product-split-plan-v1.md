# Archive — Agent Bridge OSS Product Split Plan v1

## Status

Archived. Historical context only.

This document was the first written version of the OSS product split after Epic 1. It mixed active roadmap items with broader research ideas.

The active implementation plan is now:

- `docs/roadmap/epic-11-runtime-hardening.md`

Deferred ideas are now tracked in:

- `docs/research/future-runtime-evolution.md`

## Historical Summary

The original plan proposed reframing Agent Bridge OSS as:

```text
Agent Bridge OSS
├── Companion Runtime
├── Engineering Worker
└── Shared Runtime
```

It also proposed:

- Companion Runtime as a domain-agnostic conversational runtime.
- Engineering Worker as a software-engineering-only autonomous engine.
- Shared Runtime for SQLite, eventing, memory, provider adapters, notifications, metrics, and capability management.
- Agent-Reach as an influence on Companion Runtime and capability design.
- Agent Orchestrator and gstack as influences on Engineering Worker workflows.

## Superseded Direction

The following ideas were moved out of the active roadmap and into research:

- full Agent-Reach integration
- broad internet capability ecosystem
- browser automation
- WhatsApp / Slack / Matrix
- capability marketplace
- broad source tree reorganization
- large-scale renaming

## Retained Direction

The high-value parts were retained for Epic 11:

- document the two-product OSS architecture
- introduce a minimal Capability Registry
- consolidate provider selection into Shared Runtime seams
- preserve strict Companion Runtime / Engineering Worker boundaries
- add doctor diagnostics

## Do Not Implement From This File

This archived note must not be used as an implementation source by coding agents.
