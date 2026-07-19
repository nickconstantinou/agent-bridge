# Agent Bridge OSS — Architecture Index

Architecture-first and TDD-first. Canonical documents describe the approved target behaviour; implementation is checked against them.

| Doc | Deliverable | Status |
|---|---|---|
| [01-current-architecture.md](01-current-architecture.md) | Current Architecture Review | Historical baseline |
| [02-gap-analysis.md](02-gap-analysis.md) | Gap Analysis | Historical roadmap input |
| [03-target-architecture.md](03-target-architecture.md) | Target Architecture | Canonical |
| [04-adrs.md](04-adrs.md) | Consolidated ADR summary | Canonical index |
| [05-epics.md](05-epics.md) | Earlier implementation roadmap | Historical roadmap input |
| [06-interface-specs.md](06-interface-specs.md) | Interface specifications | Maintained where still authoritative |
| [07-data-and-event-model.md](07-data-and-event-model.md) | Database and event model | Maintained where still authoritative |
| [08-testing-strategy.md](08-testing-strategy.md) | Testing strategy | Canonical |
| [09-risk-register.md](09-risk-register.md) | Risk register | Maintained |
| [10-production-readiness.md](10-production-readiness.md) | Production readiness checklist | Canonical |
| [engineering-worker.md](engineering-worker.md) | Engineering Worker product boundary and invariants | Canonical |
| [agentic-worker-orchestration.md](agentic-worker-orchestration.md) | Role-based requirements, planning, execution, review, and documentation architecture | Canonical |

## Role-based orchestration decision

Issue #159 establishes three configurable roles:

- Technical Lead;
- Code Worker;
- Documentation Steward.

Scanner is a Code Worker mode. Independent review and operations are Technical Lead modes. Agent Bridge remains authoritative for workflow state, permissions, role/model resolution, validation, deterministic evidence, approvals, merge, deployment, and audit.

Read alongside:

- `docs/agentic-maintenance.md`;
- `docs/decisions/ADR-009-role-based-agentic-orchestration.md`;
- `docs/configuration/agent-role-assignment.md`;
- `docs/operations/agentic-worker-runbook.md`;
- `docs/testing/agentic-worker-verification.md`;
- `docs/implementation-plans/issue-159-role-based-orchestration.md`;
- `agentic-maintenance.yaml`.

## Ground rules

- Extend existing provider, advisor, worker, repository, workspace, supervisor, and lifecycle boundaries rather than introducing competing systems.
- Incoming issues and scan findings are requirements inputs, not automatically implementation-ready work.
- No implementation plan is created before a canonical issue is `requirements_ready`.
- The Technical Lead is read-only; mutation is performed only by bounded Code Worker or Documentation Steward modes.
- Deterministic evidence and human gates outrank model output.
- Architecture and documentation changes must be reflected in the machine-readable document registry.

## Implementation order

Follow `docs/implementation-plans/issue-159-role-based-orchestration.md`. Coordinate advisor evidence with Issues #100 and #146, durable lifecycle with Issue #119, and revise the checkpoint-only assumptions in Issue #132 rather than creating duplicate services.