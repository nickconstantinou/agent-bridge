# Agent Bridge Documentation

Status: canonical documentation index.

Validated against: `agent/role-based-worker-orchestration-docs` for the Issue #159 target-state documentation set.

## Authority order

When documents disagree, use this order:

1. `docs/adr/` — accepted architectural decisions.
2. `docs/architecture/` — current intended architecture.
3. `docs/roadmap/` — approved implementation work.
4. Operational, configuration, and testing guides.
5. Detailed implementation handoffs and completed implementation records.
6. Research documents, unless promoted through an ADR and active roadmap.
7. Archived documents.

Coding agents must not implement from research or archive documents unless the proposal has been promoted through an accepted ADR and active roadmap.

## Status taxonomy

| Status | Meaning |
|---|---|
| `authoritative` | Current source of truth for architecture, decisions, configuration, testing, or operations. |
| `active-roadmap` | Approved implementation work. |
| `implemented-record` | Completed work and verification context. |
| `partially-implemented` | Contains both current and planned material; revalidate before implementation. |
| `superseded-pointer` | Redirects readers to current documents. |
| `research-only` | Evaluation material, not approved implementation work. |
| `archived` | Historical context only. |
| `runtime-design` | Design for a runtime asset; check current code before changing it. |

## Role-based Engineering Worker reading order

1. `docs/adr/ADR-005-role-based-agentic-orchestration.md` — accepted decision.
2. `docs/architecture/engineering-worker.md` — worker boundary and invariants.
3. `docs/architecture/agentic-worker-orchestration.md` — role, workflow, permission, and lifecycle architecture.
4. `docs/agentic-maintenance.md` — feature, defect, and refactor requirements contracts.
5. `docs/roadmap/issue-159-role-based-orchestration.md` — active implementation roadmap.
6. `docs/implementation-plans/issue-159-role-based-orchestration.md` — detailed coding-agent handoff.
7. `docs/configuration/agent-role-assignment.md` — CLI/model allocation and degraded operation.
8. `docs/operations/agentic-worker-runbook.md` — enablement, recovery, and rollback.
9. `docs/testing/agentic-worker-verification.md` — verification contract.
10. `agentic-maintenance.yaml` — machine-readable document registry and triggers.
11. `docs/WORKER-GUIDE.md` — user and operator guide.

## Canonical map

| Path | Classification | Notes |
|---|---|---|
| `docs/adr/ADR-001-oss-product-split.md` | authoritative ADR | OSS product split. |
| `docs/adr/ADR-002-shared-runtime.md` | authoritative ADR | Shared Runtime. |
| `docs/adr/ADR-003-capability-registry.md` | authoritative ADR | Capability registry. |
| `docs/adr/ADR-004-engineering-worker-boundary.md` | authoritative ADR | Software-engineering-only worker boundary. |
| `docs/adr/ADR-005-role-based-agentic-orchestration.md` | authoritative ADR | Three role orchestration decision. |
| `docs/architecture/overview.md` | authoritative architecture | Top-level architecture hierarchy. |
| `docs/architecture/companion-runtime.md` | authoritative architecture | Companion Runtime boundary. |
| `docs/architecture/engineering-worker.md` | authoritative architecture | Engineering Worker boundary and invariants. |
| `docs/architecture/agentic-worker-orchestration.md` | authoritative architecture | Role-based worker architecture. |
| `docs/architecture/shared-runtime.md` | authoritative architecture | Shared Runtime boundary. |
| `docs/architecture/memory-and-handoff.md` | authoritative architecture | Memory and provider handoff. |
| `docs/architecture/platform-boundary.md` | authoritative architecture | OSS/platform ownership. |
| `docs/architecture/03-target-architecture.md` | target architecture | Advisory beneath canonical architecture docs. |
| `docs/architecture/04-adrs.md` | ADR summary | Individual files under `docs/adr/` are authoritative. |
| `docs/architecture/08-testing-strategy.md` | authoritative testing summary | Acceptance-first role-boundary testing. |
| `docs/architecture/10-production-readiness.md` | authoritative readiness | Production qualification checklist. |
| `docs/roadmap/epic-11-runtime-hardening.md` | active roadmap | Runtime hardening. |
| `docs/roadmap/issue-69-compact-memory-handoff.md` | active roadmap | Memory and handoff implementation. |
| `docs/roadmap/issue-159-role-based-orchestration.md` | active roadmap | Issue #159 implementation. |
| `docs/implementation-plans/issue-159-role-based-orchestration.md` | detailed handoff | TDD slices, boundaries, rollout, verification, and execution contract. |
| `docs/agentic-maintenance.md` | authoritative workflow | Requirements intake and completion contracts. |
| `docs/configuration/agent-role-assignment.md` | authoritative configuration | Role CLI/model selection. |
| `docs/operations/agentic-worker-runbook.md` | authoritative operations | Enablement, recovery, and rollback. |
| `docs/testing/agentic-worker-verification.md` | authoritative testing | Detailed verification contract. |
| `agentic-maintenance.yaml` | machine-readable policy | Documents, triggers, authoring paths, and readiness. |
| `docs/WORKER-GUIDE.md` | authoritative operations | Worker user/operator guide. |
| `docs/SAFE-RESTART.md` | authoritative operations | Safe restart procedure. |

The existing research, archive, implementation-record, and superseded-pointer classifications remain subordinate to this authority order. Revalidate them before using them as implementation input.

## Runtime dependency notes

- Worker role documents are not loaded implicitly unless implementation explicitly reads `agentic-maintenance.yaml` or selects them as bounded context.
- `docs/WORKER-GUIDE.md` and `docs/SAFE-RESTART.md` are authoritative operator documents.
- Superseded pointers remain until inbound references are cleaned up.

## Reorganisation rule

Do not move or archive a document until `docs/DOCUMENTATION-AUDIT.md` confirms whether code, tests, `AGENTS.md`, README, systemd, worker prompts, or operator flows still reference it.