---
status: active-roadmap
type: roadmap
authority: canonical
implementation_status: planned
last_validated_against: agent/role-based-worker-orchestration-docs
---

# Issue #159 — Role-Based Agentic Orchestration

## Goal

Implement the accepted role-based Engineering Worker architecture from `docs/adr/ADR-005-role-based-agentic-orchestration.md`.

The worker exposes exactly three configurable roles:

- Technical Lead;
- Code Worker;
- Documentation Steward.

Agent Bridge remains authoritative for requirements state, workflow transitions, permissions, role/model resolution, evidence, budgets, retries, cancellation, approvals, merge, deployment, and audit.

## Approved scope

- feature, defect, and refactor requirements validation before planning;
- canonical issue contracts and `requirements_ready` gate;
- Technical Lead through the existing advisor service with typed bounded read-only evidence;
- Technical Lead-authored implementation plans and work packets;
- Code Worker read-only scan/investigate plus bounded TDD mutation modes;
- Documentation Steward impact, documentation-only authoring, and validation;
- explicit CLI/model/fallback assignment for each role;
- single-CLI and single-model operation with degradation reporting;
- lifecycle, cancellation, restart, lease, audit, migration, rollback, and platform coordination.

## Implementation strategy

Deliver this as a strangler extension of the current worker, not a rewrite.

Retain the current queue, repositories, handler map, executor loop, leases, cancellation, TDD commit guards, workspaces, process supervisor, AdvisorService, plan validator, GitHub lifecycle, and merge gate.

Add role configuration, deterministic resolution, requirements/canonical issue phases, role-aware planning/review, documentation phases, and desired/effective platform configuration behind compatibility controls. Do not introduce a new workflow engine, queue, supervisor, state store, or merge path.

## Delivery slices

0. Current-state reconciliation, child issue creation, and linked platform plan.
1. Role domain, additive persistence, and dormant status projection.
2. CLI/model discovery and deterministic role resolution.
3. Mode-specific permission enforcement through existing dispatch boundaries.
4. Requirements validation, human clarification, and canonical GitHub issue reconciliation.
5. Bounded Technical Lead tools and advisor-authored implementation planning.
6. Code Worker scan candidates and bounded execution packets through existing TDD handlers.
7. Documentation Steward phases in the existing implementation workspace.
8. Technical Lead implementation and operations review after deterministic verification.
9. Lifecycle, audit, compatibility, migration, and rollback qualification.
10. Platform desired/effective role assignment API and UI.

Each child issue must enumerate production-boundary red tests, the expected current failure, the focused red command, sibling behaviour that remains green, migration/rollback impact, documentation triggers, and exact dependency.

## Detailed implementation plan

The complete coding-agent handoff, authority decisions, minimal-change boundaries, comprehensive red-test catalogue, verification matrix, rollout, and execution contract are in:

- `docs/implementation-plans/issue-159-role-based-orchestration.md`

That plan is normative for implementation and subordinate only to the accepted ADR, canonical architecture, Issue #159, and current repository evidence. Material implementation discoveries must update both this roadmap status and the detailed plan rather than silently changing scope.

## Dependencies and coordination

- Issue #100 — bounded advisor debug/read-only evidence;
- Issue #119 — durable lifecycle, cancellation, lease, restart, and stale ownership;
- Issue #132 — existing advisor checkpoint scope, revised by this roadmap;
- Issue #146 — freshness and authority metadata;
- PR #157 — transitional fail-closed plan-contract repair;
- linked `agent-bridge-platform` issue created during Slice 0.

## Human gates

Human approval remains required for:

- child-issue decomposition;
- unresolved product decisions;
- material canonical issue changes;
- role defaults and high-risk review policy;
- merge;
- production deployment/restart;
- destructive, secret, permission, or policy changes.

## Completion

Complete only when all linked OSS and platform slices are implemented and independently reviewed, existing worker flows remain compatible except for explicitly approved phase changes, comprehensive red tests and exact-head evidence pass, migration and rollback are qualified, target-state documentation matches reality, and no unresolved blocker remains.