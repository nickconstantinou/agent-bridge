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

## Recommended approach (approved)

Implement in **strict value order** and reassess after the first tranche. Roughly half the roadmap pays off regardless of product ambition; the other half only pays off if OSS Agent Bridge gains real external users. Do not build the second half on spec.

**Tranche 1 — do now (felt pain, live defects, proven bug classes):**

| Order | Item | Justification |
|---|---|---|
| 0 | Phase 0 hotfixes: R1 error-classification scoping, R2 appliance token collision | Live defects, not architecture |
| 1 | Epic 1 (config consolidation + boundaries) | 4-way config duplication already shipped a real bug |
| 2 | Epic 11 (arch-lint + acceptance-first) | Worker shipped intent-miss defects twice; cheapest fix in the set |
| 3 | Epic 2 (Provider Adapter) | Kimchi integration required 9+ file edits; more CLIs are coming |
| 4 | Epic 9 (GitHub feedback loop + issue import) | Dead /import and /list-issues commands; explicitly requested workflow |
| 5 | Finish repository wiring (Epic 4 subset) | Half-done migration is worse than none |

**Tranche 2 — deferred until a trigger fires** (second real user exists, or a concrete wall is hit): Epic 5 (declarative workflows), Epic 6 (event sourcing as truth — status columns are adequate for single-operator use), Epic 7 beyond repo+failure memory kinds, Epic 10 (journalctl is adequate at current scale), Bootstrap/Heartbeat APIs (only if the hosted platform materialises).

Guardrail: the roadmap's biggest risk is the one it names — drifting into building an engineering OS instead of using one. Reassess after Tranche 1 before starting anything in Tranche 2.
