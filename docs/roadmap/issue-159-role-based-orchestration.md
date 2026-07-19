---
status: active-roadmap
type: roadmap
authority: canonical
implementation_status: partially-implemented
last_validated_against: agent/role-based-worker-orchestration-docs
---

# Issue #159 — Role-Based Agentic Orchestration

## Goal

Implement the accepted role-based Engineering Worker architecture from `docs/adr/ADR-005-role-based-agentic-orchestration.md`.

The worker exposes exactly three configurable roles:

- Technical Lead;
- Code Worker;
- Documentation Steward.

Agent Bridge remains authoritative for requirements state, workflow transitions, permissions, role/model resolution, prompts, validators, evidence, budgets, retries, cancellation, approvals, merge, deployment, and audit.

## Delivered foundation — PR #160

PR #160 delivers:

- a source-controlled canonical registry for 21 role/mode prompt contracts;
- separate Technical Lead requirements, issue, planning, focused repair, guidance, review, operations, and readiness prompts;
- separate Code Worker scan, investigation, red, green, repair, and verification prompts;
- separate Documentation Steward impact, authoring, validation, and maintenance prompts;
- comprehensive advisor-authored red-test instructions protecting product intent, architecture, invariants, compatibility, and triggered risks;
- strengthened active implementation-plan and TDD red/green prompts;
- prompt contract version/content-hash support and contract tests;
- source-only prompt resolution for canonical and compatibility handlers;
- removal of `BridgeDb.getPrompt()`, `BridgeDb.setPrompt()`, loader database-template options, and every handler override read;
- schema migration 2, which removes an absent or empty legacy `prompts` table and fails closed if an unexpected row exists;
- target-state architecture, testing, configuration, operations, documentation, and rollout policy.

Role routing, durable role assignment, requirements lifecycle, complete structured plan persistence, permissions, Documentation Steward execution, platform allocation, and final role-workflow qualification remain to be implemented through the slices below.

## Approved scope

- feature, defect, and refactor requirements validation before planning;
- canonical issue contracts and `requirements_ready` gate;
- Technical Lead through the existing advisor service with typed bounded read-only evidence;
- Technical Lead-authored implementation plans and comprehensive red-test contracts;
- Code Worker read-only scan/investigate plus bounded TDD mutation modes;
- Documentation Steward impact, documentation-only authoring, and validation;
- explicit CLI/model/fallback assignment for each role;
- source-controlled prompt key/version/hash per role invocation;
- single-CLI and single-model operation with degradation reporting;
- lifecycle, cancellation, restart, lease, audit, migration, rollback, and platform coordination;
- completed removal of legacy database prompt overrides and their schema table.

## Prompt storage decision

Prompt text is a reviewed source artifact. Canonical and compatibility prompts resolve only from registered repository files; there is no SQLite prompt precedence or mutable runtime override API.

Schema migration 2 retires the legacy table. It treats an absent table as already removed, drops an empty table transactionally, and aborts without data loss if an unexpected row exists. On rejection, schema version 1 and the table contents remain intact for guarded investigation. Prompt rollback is application rollback to a reviewed SHA.

## Implementation strategy

Deliver this as a strangler extension of the current worker, not a rewrite.

Retain the current queue, repositories, handler map, executor loop, leases, cancellation, TDD commit guards, workspaces, process supervisor, AdvisorService, source-controlled prompt registry, plan validator, GitHub lifecycle, and merge gate.

Add role configuration, deterministic resolution, requirements/canonical issue phases, role-aware planning/review, documentation phases, and desired/effective platform configuration behind compatibility controls. Do not introduce a new workflow engine, prompt service, queue, supervisor, state store, or merge path.

## Delivery slices

0. Current-state reconciliation, child issue creation, and linked platform plan.
1. Role domain, additive persistence, and dormant status projection.
2. CLI/model discovery and deterministic role resolution.
3. Mode-specific permission enforcement through existing dispatch boundaries.
4. Requirements validation, human clarification, and canonical GitHub issue reconciliation.
5. Bounded Technical Lead tools, canonical prompt routing, comprehensive plan validation, and advisor-authored planning.
6. Code Worker scan candidates and bounded execution packets through existing TDD handlers.
7. Documentation Steward phases in the existing implementation workspace.
8. Technical Lead implementation and operations review after deterministic verification.
9. Lifecycle, audit, compatibility, migration, and rollback qualification.
10. Platform desired/effective role assignment API and UI.

Each child issue must enumerate production-boundary red tests, product and architectural intent, expected current failure, authoritative oracle, focused red command, false-positive controls, sibling behaviour that remains green, migration/rollback impact, documentation triggers, and exact dependency.

## Detailed implementation plans

- `docs/implementation-plans/issue-159-role-based-orchestration.md`
- `docs/implementation-plans/issue-159-prompt-and-red-test-contract.md`

These plans are normative for implementation and subordinate only to the accepted ADR, canonical architecture, Issue #159, and current repository evidence. Material discoveries must update the roadmap and plans rather than silently changing scope.

## Dependencies and coordination

- Issue #100 — bounded advisor debug/read-only evidence;
- Issue #119 — durable lifecycle, cancellation, lease, restart, and stale ownership;
- Issue #132 — existing advisor checkpoint scope, revised by this roadmap;
- Issue #135 — guarded database migration ownership used to roll out schema migration 2;
- Issue #146 — freshness and authority metadata;
- PR #157 — transitional fail-closed execution-contract repair;
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

Complete only when all linked OSS and platform slices are implemented and independently reviewed, all role phases use the canonical prompt registry, existing worker flows remain compatible except for explicitly approved phase changes, comprehensive red tests and exact-head evidence pass, legacy database prompt overrides remain absent, migration and rollback are qualified, target-state documentation matches reality, and no unresolved blocker remains.
