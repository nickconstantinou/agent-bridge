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

Agent Bridge remains authoritative for requirements state, workflow transitions, issue and PR mutation, permissions, role/model resolution, prompts, lifecycle skills, validators, evidence, budgets, retries, cancellation, approvals, merge, deployment, and audit.

## Delivered foundation — PR #160

PR #160 delivers:

- a source-controlled canonical registry for 22 role/mode prompt contracts;
- separate Technical Lead requirements, issue, decomposition-review, planning, focused repair, guidance, implementation review, operations review, and readiness prompts;
- separate Code Worker scan, investigation, red, green, repair, and verification prompts;
- separate Documentation Steward impact, authoring, validation, and maintenance prompts;
- a pre-mutation multi-issue bundle review against one canonical invariant matrix;
- comprehensive advisor-authored red-test instructions protecting product intent, architecture, invariants, compatibility, and triggered risks;
- reproducible target-path provenance with strict validation for all newly generated and repaired plans;
- a narrow concrete-path compatibility boundary for already-persisted pre-provenance plans;
- strengthened active implementation-plan and TDD red/green prompts;
- canonical runtime-guidance blocks in the four repository SDLC skills;
- explicit ordered lifecycle-skill mappings for every role/mode and compatibility prompt;
- fail-closed skill marker, manifest version, duplication, and budget validation;
- role-template, lifecycle-skill-set, composed-template, and rendered-content identity tests;
- exact-head review, operations, documentation, and readiness contracts;
- explicit evidence states for passed, failed, not run, not scheduled, stale, and unknown checks;
- required-versus-actual review-independence gates;
- same-delivery correction of every stale, contradictory, missing, or materially misleading required document;
- full revalidation of `docs/architecture/01-current-architecture.md`;
- source-only prompt resolution for canonical and compatibility-key handlers;
- removal of `BridgeDb.getPrompt()`, `BridgeDb.setPrompt()`, loader database-template options, and every handler override read;
- schema migration 2, which removes an absent or empty legacy `prompts` table and fails closed if an unexpected row exists;
- target-state architecture, testing, configuration, operations, documentation, and rollout policy.

Role routing, durable role assignment, requirements lifecycle, complete structured plan persistence, permissions, Documentation Steward execution, platform allocation, durable prompt/skill audit persistence, and final role-workflow qualification remain to be implemented through the slices below.

## Approved scope

- feature, defect, and refactor requirements validation before planning;
- bundle-wide consistency review before multi-issue GitHub mutation;
- canonical issue contracts and `requirements_ready` gate;
- Technical Lead through the existing advisor service with typed bounded read-only evidence;
- Technical Lead-authored implementation plans and comprehensive red-test contracts;
- Code Worker read-only scan/investigate plus bounded TDD mutation modes;
- Documentation Steward impact, documentation-only authoring, and validation;
- explicit CLI/model/fallback assignment for each role;
- source-controlled prompt key/version and role-template hash per role invocation;
- source-controlled lifecycle skill key/version/content hashes and composed-template hash per role invocation;
- exact-head verification, review, operations, documentation, readiness, and CI evidence;
- single-CLI and single-model operation with degradation reporting;
- lifecycle, cancellation, restart, lease, audit, migration, rollback, and platform coordination;
- completed removal of legacy database prompt overrides and their schema table.

## Prompt and skill storage decision

Prompt text and reusable SDLC know-how are reviewed source artefacts. Canonical and compatibility-key prompts resolve only from registered repository files; there is no SQLite prompt precedence or mutable runtime override API.

The four canonical skills are `requirements-to-acceptance`, `risk-based-test-strategy`, `red-green-refactor-tdd`, and `release-readiness-review`. Role and compatibility contracts declare exactly which skills they consume. The loader validates one marked runtime block and the matching manifest version, then composes the skills deterministically. Prompt-specific authority and structured output remain in role prompts and code.

Schema migration 2 retires the legacy table. It treats an absent table as already removed, drops an empty table transactionally, and aborts without data loss if an unexpected row exists. On rejection, schema version 1 and the table contents remain intact for guarded investigation. Prompt rollback is application rollback to a reviewed SHA.

## Implementation strategy

Deliver this as a strangler extension of the current worker, not a rewrite.

Retain the current queue, repositories, handler map, executor loop, leases, cancellation, TDD commit guards, workspaces, process supervisor, AdvisorService, source-controlled prompt and skill registries, plan validator, GitHub lifecycle, and merge gate.

Add role configuration, deterministic resolution, requirements/canonical issue phases, role-aware planning/review, documentation phases, durable prompt/skill audit identity, and desired/effective platform configuration behind compatibility controls. Do not introduce a new workflow engine, prompt service, queue, supervisor, state store, GitHub mutation path, platform transport, or merge path.

## Multi-issue mutation gate

Before Agent Bridge creates or updates multiple child issues:

1. assemble every proposed issue body without mutation;
2. record current owners, caller paths, dependencies, and one canonical invariant table;
3. run `technical_lead:decomposition_review`;
4. distinguish implementation delivery order from runtime phase order;
5. repair all conflicts and rerun review;
6. allow issue mutation only after `ready_for_issue_mutation`.

## Delivery slices

The numbered list is **implementation delivery order**, not runtime phase order.

0. Current-state reconciliation, pre-mutation bundle review, child issue creation, and linked platform plan.
1. Role domain, additive persistence, and dormant status projection.
2. CLI/model discovery and deterministic role resolution.
3. Mode-specific permission enforcement through existing dispatch boundaries.
4. Requirements validation, human clarification, and canonical GitHub issue reconciliation.
5. Bounded Technical Lead tools, canonical prompt/skill routing, comprehensive plan validation, and advisor-authored planning.
6. Code Worker scan candidates and bounded execution packets through existing TDD handlers.
7. Dormant Documentation Steward capability in the existing implementation workspace.
8. Technical Lead implementation/operations review and activation of review-before-documentation runtime composition.
9. Lifecycle, durable prompt/skill audit, compatibility, migration, and rollback qualification.
10. Platform desired/effective role assignment API and UI.

Canonical runtime order after activation:

```text
deterministic verification
→ Technical Lead implementation review
→ Technical Lead operations review when triggered
→ Documentation Steward authoring and validation
→ Technical Lead PR readiness
→ exact-head CI
→ human merge gate
```

A code-changing repair invalidates verification, review, operations, documentation, and readiness evidence for the previous head.

Each child issue must enumerate production-boundary red tests, product and architectural intent, expected current failure, authoritative oracle, focused red command, false-positive controls, sibling behaviour remaining green, migration/rollback impact, documentation triggers, classified target paths, and exact dependencies.

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
- linked `agent-bridge-platform` role-allocation issue created during Slice 0.

## Documentation and readiness

Every required document triggered by `agentic-maintenance.yaml` must be current and validated against the exact final head. Missing, stale, contradictory, or materially misleading required documentation is a blocker and must be corrected in the same delivery. A later issue or assigned owner does not satisfy readiness.

A validated `no_documentation_change` result remains allowed only with rationale, trigger evidence, and Technical Lead validation.

## Human gates

Human approval remains required for:

- child-issue decomposition;
- unresolved product decisions;
- material canonical issue or delivery-scope changes;
- role defaults and high-risk review policy;
- merge;
- production deployment/restart;
- destructive, secret, permission, or policy changes.

## Completion

Complete only when all linked OSS and platform slices are implemented and independently reviewed, all role phases use the canonical prompt and lifecycle-skill registries, existing worker flows remain compatible except for explicitly approved phase changes, comprehensive red tests and exact-head evidence pass, prompt/skill identities are durably auditable, legacy database prompt overrides remain absent, migration and rollback are qualified, every required document matches reality, and no unresolved blocker remains.
