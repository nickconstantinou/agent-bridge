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

## Detailed implementation plan

The complete coding-agent handoff, TDD phase sequence, expected boundaries, verification matrix, rollout, and execution contract are in:

- `docs/implementation-plans/issue-159-role-based-orchestration.md`

That plan is normative for implementation and subordinate only to the accepted ADR, canonical architecture, Issue #159, and current repository evidence. Material implementation discoveries must update both this roadmap status and the detailed plan rather than silently changing scope.

## Dependencies and coordination

- Issue #100 — bounded advisor debug/read-only evidence;
- Issue #119 — durable lifecycle, cancellation, lease, restart, and stale ownership;
- Issue #132 — existing advisor checkpoint scope, revised by this roadmap;
- Issue #146 — freshness and authority metadata;
- PR #157 — transitional fail-closed plan-contract repair.

## Completion

Complete only when all Issue #159 acceptance criteria pass at the exact final head, target-state documentation matches implementation, platform role allocation is linked or delivered, migration and rollback are proven, and the required retrospective is recorded.