# Agent Bridge Documentation

Status: canonical documentation index.

Validated against: `agent/role-based-worker-orchestration-docs` for the Issue #159 target-state and prompt-foundation implementation set.

## Authority order

When documents disagree, use this order:

1. `docs/adr/` — accepted architectural decisions.
2. `docs/architecture/` — current intended architecture, including prompt contracts.
3. `docs/roadmap/` — approved implementation work and delivery status.
4. Operational guides — current operator procedures and runtime-specific guides.
5. Implementation records and detailed handoffs — execution guidance subordinate to the accepted ADR, architecture, and active roadmap.
6. `docs/research/` and root `*-research.md` files — research only unless promoted into a roadmap.
7. `docs/archive/` — historical context only.

Coding agents must not implement from research or archive documents unless the idea has been promoted through an ADR and an active roadmap.

## Status taxonomy

Use these labels when creating or updating docs:

| Status | Meaning |
|---|---|
| `authoritative` | Current source of truth for architecture, decisions, configuration, testing, or operations. |
| `active-roadmap` | Approved implementation work. |
| `implemented-record` | Records completed work and verification; useful context, not a standing roadmap. |
| `partially-implemented` | Some claims match code; remaining content is planned, deferred, or stale. |
| `superseded-pointer` | Kept only to redirect readers to current docs. |
| `research-only` | Evaluation material; not approved implementation work. |
| `archived` | Historical context only. |
| `runtime-design` | Design doc for a runtime asset or behavior; check code before moving. |

## Recommended front matter

New significant docs should start with a small status block:

```yaml
---
status: authoritative | active-roadmap | implemented-record | partially-implemented | superseded-pointer | research-only | archived | runtime-design
type: architecture | adr | roadmap | operations | configuration | testing | research | archive | implementation-record | runtime-design
authority: canonical | advisory | historical | none
implementation_status: implemented | partially-implemented | planned | deferred | rejected | superseded | not-applicable
last_validated_against: <commit-sha-or-branch>
---
```

## Role-based Engineering Worker reading order

1. `docs/adr/ADR-005-role-based-agentic-orchestration.md` — accepted decision.
2. `docs/architecture/engineering-worker.md` — worker boundary and invariants.
3. `docs/architecture/agentic-worker-orchestration.md` — role, workflow, permission, and lifecycle architecture.
4. `docs/architecture/agentic-prompt-contracts.md` — source-controlled role/mode prompts, validators, focused repair, red-test planning, and legacy override retirement.
5. `docs/agentic-maintenance.md` — feature, defect, and refactor requirements/planning contracts.
6. `docs/roadmap/issue-159-role-based-orchestration.md` — active implementation roadmap and delivered prompt foundation.
7. `docs/implementation-plans/issue-159-role-based-orchestration.md` — epic coding-agent handoff and delivery slices.
8. `docs/implementation-plans/issue-159-prompt-and-red-test-contract.md` — normative prompt and comprehensive red-test addendum.
9. `docs/configuration/agent-role-assignment.md` — CLI/model allocation and degraded operation.
10. `docs/operations/agentic-worker-runbook.md` — enablement, recovery, and rollback.
11. `docs/testing/agentic-worker-verification.md` — verification contract.
12. `agentic-maintenance.yaml` — machine-readable document registry and triggers.
13. `docs/WORKER-GUIDE.md` — user and operator guide.

## Current map

| Path | Classification | Authority | Notes |
|---|---|---|---|
| `docs/adr/ADR-001-oss-product-split.md` | authoritative | canonical | Accepted OSS product split. |
| `docs/adr/ADR-002-shared-runtime.md` | authoritative | canonical | Accepted Shared Runtime decision. |
| `docs/adr/ADR-003-capability-registry.md` | authoritative | canonical | Accepted minimal Epic 11 registry decision. |
| `docs/adr/ADR-004-engineering-worker-boundary.md` | authoritative | canonical | Accepted software-engineering-only worker boundary. |
| `docs/adr/ADR-005-role-based-agentic-orchestration.md` | authoritative | canonical | Accepted Technical Lead, Code Worker, and Documentation Steward orchestration decision. |
| `docs/architecture/overview.md` | authoritative | canonical | Top-level architecture and documentation hierarchy. |
| `docs/architecture/companion-runtime.md` | authoritative | canonical | Companion Runtime boundary. |
| `docs/architecture/engineering-worker.md` | authoritative | canonical | Engineering Worker boundary and role orchestration invariants. |
| `docs/architecture/agentic-worker-orchestration.md` | authoritative | canonical | Requirements, role assignment, permissions, workflow, review, operations, and documentation architecture. |
| `docs/architecture/agentic-prompt-contracts.md` | authoritative | canonical | Source-controlled role/mode prompt registry, red-test planning, focused repair, and DB override retirement. |
| `docs/architecture/shared-runtime.md` | authoritative | canonical | Shared Runtime boundary, including the memory/handoff seam note for issue #69. |
| `docs/architecture/memory-and-handoff.md` | authoritative | canonical | Compact-first memory, persistent memory promotion, and CLI handoff architecture for issue #69. |
| `docs/architecture/capability-registry.md` | active architecture | canonical for intended design | Scope controlled by Epic 11 roadmap. |
| `docs/architecture/platform-boundary.md` | authoritative | canonical | OSS/platform ownership boundary. |
| `docs/architecture/01-current-architecture.md` | implemented-record | advisory | Snapshot audit; useful evidence, not higher than newer ADRs. |
| `docs/architecture/02-gap-analysis.md` | partially-implemented | advisory | Backlog/gap list; revalidate before building. |
| `docs/architecture/03-target-architecture.md` | partially-implemented | advisory | Updated role-based target architecture, subordinate to newer canonical architecture docs. |
| `docs/architecture/04-adrs.md` | ADR summary | advisory | Individual records under `docs/adr/` are authoritative. |
| `docs/architecture/05-epics.md` | partially-implemented roadmap record | advisory | Earlier roadmap; revalidate against active roadmaps. |
| `docs/architecture/06-interface-specs.md` | partially-implemented interface reference | advisory | Revalidate against current code and accepted ADRs. |
| `docs/architecture/07-data-and-event-model.md` | partially-implemented data reference | advisory | Revalidate against current schema and repositories. |
| `docs/architecture/08-testing-strategy.md` | authoritative testing summary | canonical | Acceptance-first and role-boundary testing strategy. |
| `docs/architecture/09-risk-register.md` | risk register | advisory | Revalidate risks during implementation and rollout. |
| `docs/architecture/10-production-readiness.md` | authoritative readiness | canonical | Role orchestration production qualification gate. |
| `docs/roadmap/epic-11-runtime-hardening.md` | active-roadmap | canonical | Earlier approved runtime-hardening roadmap. |
| `docs/roadmap/issue-69-compact-memory-handoff.md` | active-roadmap | canonical | TDD implementation plan for compact-first memory and one-time CLI handoff context. |
| `docs/roadmap/issue-69-coding-agent-prompt.md` | active-roadmap | advisory | Ready-to-use implementation prompt; subordinate to architecture and roadmap docs. |
| `docs/roadmap/issue-159-role-based-orchestration.md` | active-roadmap, partially implemented | canonical | Prompt foundation delivered; remaining role orchestration tracked by slices. |
| `docs/implementation-plans/issue-159-role-based-orchestration.md` | detailed implementation handoff | advisory under roadmap | Minimal-change delivery slices, red-test catalogue, migration, rollout, verification, and execution contract. |
| `docs/implementation-plans/issue-159-prompt-and-red-test-contract.md` | normative implementation addendum | advisory under roadmap | Prompt separation, comprehensive advisor-authored red-test requirements, and DB override retirement. |
| `docs/agentic-maintenance.md` | authoritative workflow | canonical | Feature, defect, refactor, planning, prompt, and completion contracts. |
| `docs/configuration/agent-role-assignment.md` | authoritative configuration | canonical | Role CLI/model allocation, fallbacks, and degraded operation. |
| `docs/operations/agentic-worker-runbook.md` | authoritative operations | canonical | Role enablement, status, cancellation, recovery, and rollback. |
| `docs/testing/agentic-worker-verification.md` | authoritative testing | canonical | Detailed role, prompt, planning, lifecycle, and rollout verification contract. |
| `agentic-maintenance.yaml` | machine-readable policy | canonical | Canonical documents, triggers, authoring paths, readiness, prompt changes, and role modes. |
| `src/agenticPromptContracts.ts` | implemented prompt foundation | canonical runtime registry | Versioned 21-key role/mode prompt registry; source-controlled only. |
| `prompts/worker/roles/` | implemented prompt foundation | canonical runtime prompts | Separate Technical Lead, Code Worker, and Documentation Steward prompt files. |
| `docs/WORKER-GUIDE.md` | authoritative operations | canonical for worker use | Role-based worker guide, prompt contracts, red-test quality, and legacy override retirement. |
| `docs/SAFE-RESTART.md` | authoritative operations | canonical for safe restart helper | Referenced by `AGENTS.md` restart policy. |
| `docs/PRD.md` | partially-implemented product reference | advisory | Broad product/architecture reference; defer to ADRs and architecture docs on conflicts. |
| `docs/soul.md` | runtime-design | advisory/canonical for SOUL.md behavior | Documents root `SOUL.md` runtime injection; the doc itself is not the default loaded file. |
| `docs/agent-driven-memory-research.md` | implemented-record | advisory | Historical memory research and verification; current intended memory architecture is `docs/architecture/memory-and-handoff.md`. |
| `docs/bridge-event-normalization-research.md` | implemented-record plus deferred research | advisory | Phases 1-5 completed; Phase 6 deferred. |
| `docs/discord-compatibility-research.md` | implemented-record plus follow-up checklist | advisory | Discord baseline implemented; operational hardening remains. |
| `docs/health-bolt-architecture.md` | implemented-record | advisory | Shared-engine health architecture implemented. |
| `docs/health-monitor-rectification.md` | implemented-record/checklist | advisory | Rectification mostly complete; monitor follow-up remains. |
| `docs/native-telegram-layout-spike.md` | partially-implemented / partially-superseded | advisory | Status should be refreshed before further implementation. |
| `docs/prompt-optimization-loop-research.md` | implemented-record plus stale research notes | advisory | Referenced by `AGENTS.md`; revalidate code references. |
| `docs/antigravity-agent-view-spike.md` | research-only | none | Spike complete; no default background-mode implementation. |
| `docs/claude-agent-view-spike.md` | research-only | none | Background mode rejected as default; optional future idea only. |
| `docs/cursor-agent-spike-research.md` | rejected research | none | Not viable as backend. |
| `docs/cursor-sdk-spike-research.md` | conditional research | none | Potential future backend only with API key and shim; not current roadmap. |
| `docs/autonomous-agent-bridge-research.md` | superseded-pointer | none | Redirects to worker guide, active roadmap, research, and archive. |
| `docs/oss-product-split-plan.md` | superseded-pointer | none | Redirects to Epic 11 roadmap, research, and archive. |
| `docs/research/future-runtime-evolution.md` | research-only | none | Deferred ideas; promotion rules apply. |
| `docs/archive/autonomous-agent-bridge-research-v1.md` | archived | historical | Historical context only. |
| `docs/archive/oss-product-split-plan-v1.md` | archived | historical | Historical context only. |

## Runtime dependency notes

- `docs/soul.md` is a design document. Runtime loading is handled by `src/soul.ts`, which defaults to `<project>/SOUL.md` or `AGENT_BRIDGE_SOUL_PATH`.
- `docs/architecture/memory-and-handoff.md` is the current intended memory and provider-handoff architecture. Implementation work is tracked in `docs/roadmap/issue-69-compact-memory-handoff.md`.
- Canonical role prompts are loaded from source-controlled files registered by `src/agenticPromptContracts.ts`; legacy handlers still use `src/workerPrompts.ts` until migrated.
- The SQLite `prompts` table is a deprecated legacy override channel, not a backup or canonical source.
- `docs/prompt-optimization-loop-research.md` is referenced by `AGENTS.md` for optimizer methodology. It is not loaded by runtime services.
- `docs/WORKER-GUIDE.md` and `docs/SAFE-RESTART.md` are authoritative operator docs. They are not loaded by services.
- Superseded pointer files should stay until inbound references are cleaned up, then they can move fully into `docs/archive/`.

## Reorg rule

Do not move or archive a document or prompt until `docs/DOCUMENTATION-AUDIT.md` classifies it and confirms whether code, tests, `AGENTS.md`, README, systemd, worker prompts, compatibility aliases, or operator flows still reference it.