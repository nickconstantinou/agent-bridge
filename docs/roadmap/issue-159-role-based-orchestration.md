---
status: active-roadmap
type: roadmap
authority: canonical
implementation_status: partially-implemented
last_validated_against: db2ab80f6895bad76cdf46930790bfe70691408a
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

PR #160 at exact head `db2ab80f6895bad76cdf46930790bfe70691408a` delivers:

- a source-controlled canonical registry for 22 role/mode prompt contracts;
- separate Technical Lead requirements, issue, decomposition-review, planning, focused repair, guidance, implementation review, operations review, and readiness prompts;
- separate Code Worker scan, investigation, red, green, repair, and verification prompts;
- separate Documentation Steward impact, authoring, validation, and maintenance prompts;
- a pre-mutation multi-issue bundle review against one canonical invariant matrix;
- comprehensive advisor-authored red-test instructions protecting product intent, architecture, invariants, compatibility, and triggered risks;
- reproducible target-path provenance with strict validation for newly generated and repaired plans;
- a narrow concrete-path compatibility boundary for already-persisted pre-provenance plans;
- strengthened active implementation-plan and TDD red/green prompts;
- canonical runtime-guidance blocks in the four repository SDLC skills;
- explicit ordered lifecycle-skill mappings for every role/mode and compatibility prompt;
- fail-closed skill marker, manifest version, duplication, and budget validation;
- role-template, lifecycle-skill-set, composed-template, and rendered-content identity tests;
- exact-head review, operations, documentation, readiness, CI, and final Technical Lead review contracts;
- explicit evidence states for passed, failed, not run, not scheduled, stale, and unknown checks;
- Technical Lead/Code Worker role-separation review independence, with model diversity recorded as optional metadata rather than a blocking requirement;
- same-delivery correction of every stale, contradictory, missing, or materially misleading required document;
- full revalidation of `docs/architecture/01-current-architecture.md`;
- source-only prompt resolution for canonical and compatibility-key handlers;
- removal of `BridgeDb.getPrompt()`, `BridgeDb.setPrompt()`, loader database-template options, and every handler override read;
- schema migration 2, which removes an absent or empty legacy `prompts` table and fails closed if an unexpected row exists;
- target-state architecture, testing, configuration, operations, documentation, and rollout policy.

Role routing, durable role assignment, requirements lifecycle, complete structured plan persistence, permissions, Documentation Steward execution, platform allocation, durable prompt/skill audit persistence, and final role-workflow qualification remain to be implemented through the slices below.

## Slice 0 reconciliation

Slice 0 is documented by `docs/implementation-plans/issue-159-slice-0-reconciliation.md`. It records the exact PR #160 and Platform baselines, current owners, overlap decisions, concrete target-path classification, actual child issues, cross-repository ownership, human gates and retrospective.

Slice 0 creates documentation and issue metadata only. It does not authorize Slice 1, merge, deployment, restart, production migration, service mutation, Platform runtime mutation or any other behavioural change.

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
- exact-head verification, review, operations, documentation, readiness, CI, and final Technical Lead review evidence;
- single-CLI and single-model operation with explicit model-diversity metadata and preserved role-separation review independence;
- lifecycle, cancellation, restart, lease, audit, migration, rollback, and platform coordination;
- completed removal of legacy database prompt overrides and their schema table.

## Prompt and skill storage decision

Prompt text and reusable SDLC know-how are reviewed source artefacts. Canonical and compatibility-key prompts resolve only from registered repository files; there is no SQLite prompt precedence or mutable runtime override API.

The four canonical skills are `requirements-to-acceptance`, `risk-based-test-strategy`, `red-green-refactor-tdd`, and `release-readiness-review`. Role and compatibility contracts declare exactly which skills they consume. The loader validates one marked runtime block and the matching manifest version, then composes the skills deterministically. Prompt-specific authority and structured output remain in role prompts and code.

Schema migration 2 retires the legacy table. It treats an absent table as already removed, drops an empty table transactionally, and aborts without data loss if an unexpected row exists. On rejection, schema version 1 and the table contents remain intact for guarded investigation. Prompt rollback is application rollback to a reviewed SHA.

## Implementation strategy

Deliver this as a strangler extension of the current worker, not a rewrite.

Retain the current queue, repositories, handler map, executor loop, leases, cancellation, TDD commit guards, workspaces, process supervisor, AdvisorService, source-controlled prompt and skill registries, plan validator, GitHub lifecycle, and merge gate.

Add role configuration, deterministic resolution, requirements/canonical issue phases, role-aware planning/review, documentation phases, durable prompt/skill audit identity, and desired/effective platform configuration behind compatibility controls. Do not introduce a new workflow engine, prompt service, queue, supervisor, state store, GitHub mutation path, Platform transport, or merge path.

## Multi-issue mutation gate

Before Agent Bridge creates or updates multiple child issues:

1. assemble every proposed issue body without mutation;
2. record current owners, caller paths, dependencies, and one canonical invariant table;
3. run `technical_lead:decomposition_review`;
4. distinguish implementation delivery order from runtime phase order;
5. repair all conflicts and rerun review;
6. allow issue mutation only after `ready_for_issue_mutation`.

## Delivery issues and ordering

| Slice | Repository | Issue | Scope boundary |
|---:|---|---|---|
| 0 | agent-bridge | parent #159 and draft PR #170 | current-state reconciliation and decomposition only |
| 1 | agent-bridge | [#161](https://github.com/nickconstantinou/agent-bridge/issues/161) | role domain, additive persistence and dormant status; no routing |
| 2 | agent-bridge | [#162](https://github.com/nickconstantinou/agent-bridge/issues/162) | capability/model discovery and deterministic resolver; no handler routing |
| 3 | agent-bridge | [#163](https://github.com/nickconstantinou/agent-bridge/issues/163) | mode-specific permissions through existing dispatch/workspace/supervisor boundaries |
| 4 | agent-bridge | [#164](https://github.com/nickconstantinou/agent-bridge/issues/164) | requirements, human decisions and canonical GitHub issue reconciliation |
| 5 | agent-bridge | [#165](https://github.com/nickconstantinou/agent-bridge/issues/165) | extend #100/PR #152 evidence broker into Technical Lead planning |
| 6 | agent-bridge | [#166](https://github.com/nickconstantinou/agent-bridge/issues/166) | scan candidates and immutable Code Worker packets through current handlers |
| 7 | agent-bridge | [#167](https://github.com/nickconstantinou/agent-bridge/issues/167) | dormant Documentation Steward capability; no production documentation activation |
| 8 | agent-bridge | [#168](https://github.com/nickconstantinou/agent-bridge/issues/168) | compose and activate Technical Lead review before documentation, then final readiness |
| 9 | agent-bridge | [#169](https://github.com/nickconstantinou/agent-bridge/issues/169) | lifecycle, audit, compatibility, migration and rollout qualification |
| 10 | agent-bridge-platform | [#134](https://github.com/nickconstantinou/agent-bridge-platform/issues/134) | Platform desired revisions and desired/effective API/UI/status only |

### Implementation delivery order

The numbered graph is implementation delivery order, not runtime phase order. Slice #167 is delivered first only so #168 can compose the dormant capability into the accepted lifecycle.

```text
PR #160
  -> #161 -> #162 -> #163 -> #164 -> #165 -> #166 -> #167 (dormant) -> #168 (activation) -> #169
                                                                                              -> platform #134
```

The dependency graph also includes #100/PR #152, #132 and #146 before or within #165/#168; #135/PR #158 before #169; and Platform #72/#93/#95/#96/#119 before or within Platform #134.

### Canonical runtime order

```text
deterministic verification
→ Technical Lead implementation review
→ Technical Lead operations review when triggered
→ Documentation Steward authoring and validation
→ Technical Lead PR readiness
→ exact-head CI
→ fresh exact-head Technical Lead final review
→ human merge gate
```

The final review is independent from the Code Worker through role and authority separation. The same frontier model or CLI may be reused. A code-changing repair invalidates verification, review, operations, documentation, readiness, CI, and final-review evidence for the previous head.

Slice #167 must not activate documentation execution. Slice #168 owns activation. Documentation requires accepted review and required operations evidence for the same exact code head. A code-changing repair invalidates verification, review, operations, documentation, readiness, CI, and final-review evidence until the required phases rerun. Slice #169 qualifies the sequence across restart, retry, cancellation, lease loss, stale evidence, fallback, migration and rollback.

Each child issue enumerates production-boundary red tests, product and architectural intent, expected current failure, authoritative oracle, focused red command, false-positive controls, sibling behaviour remaining green, migration/rollback impact, documentation triggers, classified target paths, and exact dependencies.

Do not start Slice 1 until this decomposition receives maintainer approval. Do not pull a later slice into an earlier issue.

## Detailed implementation plans

- `docs/implementation-plans/issue-159-role-based-orchestration.md`
- `docs/implementation-plans/issue-159-prompt-and-red-test-contract.md`
- `docs/implementation-plans/issue-159-execution-readiness-safeguards.md`
- `docs/implementation-plans/issue-159-slice-0-reconciliation.md`

These plans are normative for implementation and subordinate only to the accepted ADR, canonical architecture, Issue #159, and current repository evidence. The Slice 0 reconciliation is authoritative for current owner modules, concrete likely target files, overlap decisions, actual issue numbers, sequencing and the cross-repository interface at the stated exact base.

## Dependencies and coordination

- Issue #100 / PR #152 — current bounded Advisor evidence/debug owner, extended by #165;
- Issue #119 / PR #120 — historical lifecycle design input; current job/repository/supervisor owners remain authoritative;
- Issue #132 — Advisor checkpoint scope, budgets and risk gates;
- Issue #135 / PR #158 — guarded database migration and rollout ownership;
- Issue #146 — freshness and authority metadata;
- PR #157 — transitional fail-closed execution-contract repair;
- Platform #134 — desired/effective role allocation after #169 OSS compatibility evidence.

## Documentation and readiness

Every required document triggered by `agentic-maintenance.yaml` must be current and validated against the exact final head. Missing, stale, contradictory, or materially misleading required documentation is a blocker and must be corrected in the same delivery. A later issue or assigned owner does not satisfy readiness.

A validated `no_documentation_change` result remains allowed only with rationale, trigger evidence, and Technical Lead validation.

## Human gates

Human approval remains required for:

- child-issue decomposition and permission to begin Slice 1;
- unresolved product decisions;
- material canonical issue or delivery-scope changes;
- role defaults and review authority policy;
- merge;
- production deployment/restart;
- database/fleet migration;
- destructive, secret, permission, or policy changes.

## Completion

Issue #159 remains open. It completes only when all linked OSS and Platform slices are implemented and independently reviewed, all role phases use the canonical prompt and lifecycle-skill registries, existing worker flows remain compatible except for explicitly approved phase changes, comprehensive red tests and exact-head evidence pass, prompt/skill identities are durably auditable, legacy database prompt overrides remain absent, migration and rollback are qualified, every required document matches reality, and no unresolved blocker remains.
