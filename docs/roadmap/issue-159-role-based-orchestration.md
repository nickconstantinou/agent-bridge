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

Agent Bridge remains authoritative for requirements state, workflow transitions, permissions, role/model resolution, evidence, prompts, structured validators, budgets, retries, cancellation, approvals, merge, deployment, and audit.

## Approved scope

- feature, defect, and refactor requirements validation before planning;
- canonical issue contracts and `requirements_ready` gate;
- Technical Lead through the existing advisor service with typed bounded read-only evidence;
- Technical Lead-authored implementation plans and work packets;
- comprehensive advisor-authored red-test specifications covering product intent, architecture, invariants, compatibility, lifecycle, security, operations, migration, and rollback risks as applicable;
- separate role/mode prompt contracts, validators, and focused repair prompts;
- Code Worker read-only scan/investigate plus bounded TDD mutation modes;
- Documentation Steward impact, documentation-only authoring, and validation;
- explicit CLI/model/fallback assignment for each role;
- single-CLI and single-model operation with degradation reporting;
- lifecycle, cancellation, restart, lease, audit, migration, rollback, and platform coordination.

## Implementation strategy

Deliver this as a strangler extension of the current worker, not a rewrite.

Retain the current queue, repositories, handler map, executor loop, leases, cancellation, TDD commit guards, workspaces, process supervisor, AdvisorService, named prompt-template boundary, database-backed prompt overrides, plan validator, PR #157 focused repair, GitHub lifecycle, and merge gate.

Add role configuration, deterministic resolution, requirements/canonical issue phases, role-aware planning/review, versioned prompt contracts, comprehensive red-test validation, documentation phases, and desired/effective platform configuration behind compatibility controls. Do not introduce a new workflow engine, prompt service, queue, supervisor, state store, or merge path.

## Delivery slices

0. Current-state reconciliation, child issue creation, prompt inventory, and linked platform plan.
1. Role domain, additive persistence, and dormant status projection.
2. CLI/model discovery and deterministic role resolution.
3. Mode-specific permission enforcement through existing dispatch boundaries.
4. Requirements validation, human clarification, and canonical GitHub issue reconciliation.
5. Bounded Technical Lead tools, separate role/mode prompt registry, advisor-authored implementation planning, comprehensive red-test contracts, and focused section repair.
6. Code Worker scan candidates and bounded execution packets through existing TDD handlers.
7. Documentation Steward phases in the existing implementation workspace.
8. Technical Lead implementation and operations review after deterministic verification.
9. Lifecycle, audit, compatibility, migration, and rollback qualification.
10. Platform desired/effective role assignment API and UI.

Each child issue must enumerate production-boundary red tests, product and architectural intent protected, the expected current failure, focused red command, authoritative oracle, sibling behaviour that remains green, risk-triggered test classes, migration/rollback impact, documentation triggers, and exact dependency.

Technical Lead-authored implementation plans must produce the same structured red-test detail. Generic instructions such as `write tests` or `add unit tests` fail validation.

## Prompt contracts

Prompts remain separate by role, mode, and repair purpose. Prompt text cannot define tools, permissions, budgets, validators, role identity, or lifecycle authority.

Canonical prompt architecture:

- `docs/architecture/agentic-prompt-contracts.md`

Required implementation behaviour:

- one registered prompt contract per role/mode;
- separate full planning, red-test repair, and execution-contract repair prompts;
- database overrides change text only and remain subject to built-in schemas and validators;
- prompt key, version, source, and content hash are audited without raw sensitive context;
- fallback models use the same prompt contract and validator;
- legacy prompt keys remain explicit compatibility aliases until qualified retirement.

## Detailed implementation plan

The complete coding-agent handoff, authority decisions, minimal-change boundaries, comprehensive red-test catalogue, verification matrix, rollout, and execution contract are in:

- `docs/implementation-plans/issue-159-role-based-orchestration.md`
- `docs/implementation-plans/issue-159-prompt-and-red-test-contract.md`

Both documents are normative for implementation and subordinate only to the accepted ADR, canonical architecture, Issue #159, and current repository evidence. Material implementation discoveries must update this roadmap and the affected detailed plan rather than silently changing scope.

## Dependencies and coordination

- Issue #100 — bounded advisor debug/read-only evidence;
- Issue #119 — durable lifecycle, cancellation, lease, restart, and stale ownership;
- Issue #132 — existing advisor checkpoint scope, revised by this roadmap;
- Issue #146 — freshness and authority metadata;
- PR #157 — transitional focused execution-contract repair and prompt-key separation pattern;
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

Complete only when all linked OSS and platform slices are implemented and independently reviewed, existing worker flows remain compatible except for explicitly approved phase changes, Technical Lead plans contain validated comprehensive red-test specifications, prompt contracts remain separate and authority-safe, exact-head evidence passes, migration and rollback are qualified, target-state documentation matches reality, and no unresolved blocker remains.
