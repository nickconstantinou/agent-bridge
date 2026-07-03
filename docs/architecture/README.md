# Agent Bridge OSS v1.0 — Architecture Review & Roadmap

Architecture-first, TDD-first. No implementation begins until this set is approved.

| Doc | Deliverable | Status |
|---|---|---|
| [01-current-architecture.md](01-current-architecture.md) | Current Architecture Review (modules, lifecycle, state model, abstractions, dependency notes) | Draft |
| [02-gap-analysis.md](02-gap-analysis.md) | Gap Analysis (current vs desired, priority, risk, migration) | Draft |
| [03-target-architecture.md](03-target-architecture.md) | Target Architecture | Draft |
| [04-adrs.md](04-adrs.md) | ADRs 001–007 | Draft |
| [05-epics.md](05-epics.md) | Implementation Roadmap + Epic Breakdown (12 epics) + suggested order | Draft |
| [06-interface-specs.md](06-interface-specs.md) | Interface Specifications (ProviderAdapter, Workflow, Events, Memory, Boundary APIs, GitHub sync) | Draft |
| [07-data-and-event-model.md](07-data-and-event-model.md) | Database/Event Model + migrations | Draft |
| [08-testing-strategy.md](08-testing-strategy.md) | Testing Strategy (acceptance-first, arch-lint, golden tests) | Draft |
| [09-risk-register.md](09-risk-register.md) | Risk Register (R1–R12) | Draft |
| [10-production-readiness.md](10-production-readiness.md) | Production Readiness Checklist | Draft |

Deliverables 3 (Target Architecture) and 12 (implementation order) are folded into docs 03 and 05 respectively; dependency graph and runtime lifecycle live in doc 01.

## Ground rules honored
- Extend, don't replace: every recommendation maps to existing modules (see "Non-gaps" in doc 02).
- Reference projects (gstack, agent-orchestrator) used for patterns only — influences table in doc 03.
- Platform (auth/billing/provisioning) excluded; boundary APIs specified in doc 06.

## Next step after approval
Implement one epic at a time under strict TDD, in the order in doc 05 §"Suggested implementation order", starting with Phase 0 hotfixes (R1 error-classification scope fix, R2 dedicated appliance token).
