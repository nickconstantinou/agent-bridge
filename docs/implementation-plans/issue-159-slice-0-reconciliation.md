---
status: review-required
type: implementation-plan-addendum
authority: current-state-reconciliation
parent_issue: 159
base_pr: 160
validated_at: 2026-07-19
---

# Issue #159 Slice 0 — Current-State Reconciliation and Child-Issue Map

## Purpose and authority

This record completes Slice 0 only. It reconciles the accepted Issue #159 architecture and implementation plans against exact repository evidence, records current authoritative owners, and links implementation Slices 1–10.

It does not authorize Slice 1, merge PR #160 or PR #170, deploy, restart, mutate a database, change a service, or alter Platform runtime configuration.

For owners, likely target files, dependencies and overlap decisions, this record supersedes stale guesses in older planning material. The accepted ADR, product decisions, canonical runtime workflow, prompt/red-test contract and human gates remain unchanged.

## Reconciled baseline

| Item | Exact evidence |
|---|---|
| OSS repository | `nickconstantinou/agent-bridge` |
| OSS `main` used by PR #160 | `1ce03d5e22ec44b3b23fef847b273f2bce08303c` |
| PR #160 branch | `agent/role-based-worker-orchestration-docs` |
| PR #160 exact head / stacked base | `4cfd960` |
| PR #160 state | open, draft, unmerged |
| Platform repository | `nickconstantinou/agent-bridge-platform` |
| Platform `main` used for reconciliation | `31d6b5e42b89eeb433e272816fd6bbb7aced2dce` |
| Slice 0 branch | `agent/issue-159-slice-0-decomposition` |
| Slice 0 stacking | created from the exact PR #160 head; PR #170 targets the PR #160 branch |

PR #160 is the runtime/schema/prompt/documentation-policy foundation. It supplies source-controlled role/mode prompts, canonical lifecycle-skill composition, the pre-mutation decomposition-review contract, comprehensive red-test and target-path provenance validation, source-only prompt resolution, schema version 2, guarded legacy prompt-table removal, and the current architecture/implementation-plan rewrite. Later slices extend those owners and must not recreate a prompt service, AdvisorService, worker execution stack, CI runner or migration authority.

The move from the original Slice 0 base to `4cfd960` comprised 311 commits and modified or added 82 paths. Previously classified exact-base targets therefore remained present, and the classification was re-anchored to the new base.

## Relevant work and non-overlap

| Work | Current role in Issue #159 |
|---|---|
| #100 / PR #152 | sole bounded Advisor read-only evidence-broker and blocked-worker debug owner; extended by Slice 5 |
| #119 / PR #120 | closed issue and plan-only historical lifecycle input; current executor/repository/supervisor owners remain authoritative |
| #132 | Advisor checkpoint budgets and risk-gate dependency |
| #135 / PR #158 | strict database boundary and guarded migration/rollout owner |
| #146 | evidence authority/freshness dependency |
| #35 | scan-trigger dependency only; Slice 6 owns candidate disposition and approved execution |
| PR #157 | focused execution-contract repair path |
| Platform #72/#93/#95/#96/#119 | runtime, worker-surface, fleet, frontend and immutable-deployment dependencies; none owns the three-role desired/effective protocol |

No exact active implementation owner was found for any Slice 1–10 responsibility. Partial overlaps remain dependencies with explicit non-overlap boundaries.

## Current authoritative owner map

| Concern | Current owner | Planned focused extension |
|---|---|---|
| role domain | accepted contracts only | `src/agentRoles.ts` in #161 |
| worker configuration | `src/config.ts`, `src/workerCliPolicy.ts` | dormant desired assignment #161; effective resolution #162 |
| schema/migrations | `src/db/schema.ts`, numbered migrations, Issue #135 | additive migrations only when proven necessary |
| SQL/repositories | `src/repositories/**`, constructed/delegated by `BridgeDb` | focused repositories only where no owner fits |
| status projection | `src/workerBot.ts`, composed by `src/index-worker.ts` | desired/dormant/effective/audit #161/#162/#169 |
| provider/model metadata | provider types, registry, selection and runtimes | role capability inputs #162 |
| role resolution | current legacy chains | pure `src/roleResolution.ts` #162 |
| permissions | dispatch, CLI, supervisor, workspace, TDD/job/merge boundaries | `src/workerPermissionProfile.ts` #163 |
| requirements/canonical issue | worker intake/callbacks, `WorkQueueRepository`, GitHub issue handler | revisions/lifecycle/reconciliation #164 |
| Advisor evidence | `AdvisorService`; PR #152 broker/redaction/audit | planning evidence modes #165 |
| planning | plan handler, quality validator, prompt/skill registries | Technical Lead planning #165 |
| TDD execution | current TDD/orchestrated handlers, workspace and Git guards | packet/profile enforcement #163/#166 |
| scans | defect/refactor handlers | candidate/disposition #166 |
| documentation | `agentic-maintenance.yaml`, workspace/job/PR lifecycle | dormant policy/handler #167 |
| review/operations/readiness | deterministic verification, Advisor, PR lifecycle and merge gate | policy and canonical composition #168 |
| final exact-head checks | existing PR lifecycle/check owners | sequenced after readiness by #168; qualified by #169 |
| jobs/restart/cancellation | executor, loop, work repository, supervisor | cross-phase qualification #169 |
| audit | Advisor/run/job records; events remain projections | focused invocation/check lineage only where necessary #169 |
| GitHub mutation | current issue/PR helpers, repository links and human merge gate | approved revision reconciliation #164 |
| Platform desired state | control-plane store/types/service/runtime/frontend | `src/control-plane/roleAllocation.ts` Platform #134 |
| appliance effective state | OSS auth/discovery/resolution/status/heartbeat | #162/#169, consumed by Platform after compatibility evidence |
| rollout/rollback | Issue #135/PR #158 and immutable Platform deployment | OSS #169 before Platform #134 |

Prohibited duplicates: no second queue, workflow engine, process supervisor, workspace manager, provider stack, AdvisorService, prompt store, CI runner, SQL path, GitHub mutation path, configuration transport, event-sourced state authority or merge path.

## Child issue map

| Slice | Repository | Issue | Primary responsibility |
|---:|---|---|---|
| 1 | agent-bridge | [#161](https://github.com/nickconstantinou/agent-bridge/issues/161) | role domain, additive persistence and dormant status; no routing |
| 2 | agent-bridge | [#162](https://github.com/nickconstantinou/agent-bridge/issues/162) | capability discovery and deterministic effective resolution; no handler routing |
| 3 | agent-bridge | [#163](https://github.com/nickconstantinou/agent-bridge/issues/163) | role-mode permissions at existing mutation boundaries |
| 4 | agent-bridge | [#164](https://github.com/nickconstantinou/agent-bridge/issues/164) | requirements, durable decisions and canonical GitHub issue reconciliation |
| 5 | agent-bridge | [#165](https://github.com/nickconstantinou/agent-bridge/issues/165) | extend PR #152 evidence into Technical Lead planning |
| 6 | agent-bridge | [#166](https://github.com/nickconstantinou/agent-bridge/issues/166) | scan candidates, dispositions and immutable execution packets |
| 7 | agent-bridge | [#167](https://github.com/nickconstantinou/agent-bridge/issues/167) | dormant Documentation Steward capability; no activation |
| 8 | agent-bridge | [#168](https://github.com/nickconstantinou/agent-bridge/issues/168) | activate review before documentation, then readiness and final checks |
| 9 | agent-bridge | [#169](https://github.com/nickconstantinou/agent-bridge/issues/169) | lifecycle, audit, compatibility, migration and rollout qualification |
| 10 | agent-bridge-platform | [#134](https://github.com/nickconstantinou/agent-bridge-platform/issues/134) | Platform desired revisions and desired/effective API/UI/status |

Every issue contains product and architecture intent, current owners, prohibited duplicates, concrete likely targets, binary acceptance criteria, production-boundary red tests, coverage matrices, migration/rollback, documentation triggers, verification and human gates.

## Implementation delivery order

The graph below is **implementation delivery order**, not runtime phase order. Slice #167 is delivered before #168 only so #168 can compose the already-built dormant Documentation Steward capability.

```text
PR #160 foundation
  → #161 → #162 → #163 → #164 → #165 → #166 → #167 (dormant) → #168 (activation) → #169
                                                                                          → Platform #134
```

The graph also includes #100/PR #152, #132 and #146 before or within #165/#168; #135/PR #158 before #169; and Platform #72/#93/#95/#96/#119 before or within Platform #134.

No later slice may be pulled into an earlier issue. Each slice remains human-gated.

## Canonical runtime order

Runtime composition is independent of the numbered delivery order:

```text
deterministic verification
→ Technical Lead implementation review
→ Technical Lead operations review when triggered
→ Documentation Steward authoring and validation or accepted no-change
→ Technical Lead PR-readiness advisory
→ final exact-head CI
→ independent final review
→ human merge gate
```

Mandatory invariants:

- Slice #167 must not activate Documentation Steward execution.
- Slice #168 owns activation of review-before-documentation, readiness, and final-check sequencing.
- Documentation requires accepted implementation review and any required operations review for the same exact code head.
- Readiness requires documentation validation or accepted no-change evidence for that head; it does not require final-check results.
- Final exact-head CI starts only after readiness and remains deterministic authority before independent final review and the human merge gate.
- A code-changing repair invalidates deterministic verification, implementation/operations review, documentation, readiness, exact-head CI, and final-review evidence for the previous head until the required phases rerun.
- Slice #169 qualifies the complete sequence across restart, retry, cancellation, lease loss, stale evidence, fallback, migration and rollback.

The accepted ADR and canonical architecture are not changed to mirror slice numbering.

## Cross-repository desired/effective contract

Platform owns desired policy, immutable monotonic revisions, authorization, history and delivery through existing bootstrap/reconciliation.

The appliance owns authentication, capability probes, validation, deterministic resolution, permissions, degradation/rejection, last-known-valid effective state and exact applied revision.

The authenticated appliance heartbeat is extended—not replaced—to report contract version, desired revision observed, exact applied revision, `pending|applied|degraded|rejected`, effective targets, bounded reasons, freshness, review independence/degradation, timestamp and last-known-valid revision. It contains no credentials or raw prompts/evidence.

Platform may report `applied` or `degraded` only when a heartbeat reports an `appliedRevision` exactly matching current desired revision. Older, absent, stale or rejected evidence cannot erase or impersonate last-known-valid truth.

OSS Slices 1–9 must be merged, deployed and disposable-appliance qualified before Platform #134 may issue actionable desired revisions. No new transport, auth mechanism, resolver, runtime writer or secrets store is introduced.

## Pre-mutation cross-slice invariant audit

Before creating or mutating multiple child issues, assemble proposed issue bodies as a read-only bundle and audit them against one canonical invariant matrix covering:

- implementation delivery order;
- runtime phase order;
- authoritative state owners;
- production caller paths;
- lifecycle transitions and terminal/restart semantics;
- permission boundaries;
- persistence, schema and SQL ownership;
- GitHub mutation and human merge authority;
- Platform desired-state versus appliance effective-state authority;
- prohibited duplicate abstractions;
- cross-slice dependencies and non-overlap.

Issue mutation may begin only after the matrix is internally consistent. This local correction prevents implementation ordering from being confused with runtime ordering. `AGENTS.md` is unchanged because existing global rules cover the underlying discipline.

## Reproducible path and link classification

The classification input was every concrete implementation target path in the owner/target sections of the Slice 0 documents, OSS Issues #161–#169 and Platform Issue #134. Generic descriptions, documentation references, globs and command names were excluded; local documentation paths were checked separately by exact-head file lookup.

Immutable references:

- OSS base: `4cfd960`;
- dependency PR #152 head: `35c6a1a988e4cf197ca71cf2a653f103156e75e7`;
- Platform base: `31d6b5e42b89eeb433e272816fd6bbb7aced2dce`.

| Category | Result |
|---|---:|
| 1. Exists at exact OSS or Platform base | 67 |
| 2. Exists in dependency PR #152 | 10 |
| 3. Proposed production path with owner/rationale | 23 |
| 4. Proposed test path | 33 |
| 5. Invalid or unclassified | **0** |
| Total deduplicated targets | 133 |

Category 2 is limited to PR #152 evidence/broker/blocked-result paths. Optional proposed paths must be revalidated at the implementing slice’s exact start head; this classification does not pre-authorize creation.

The documentation-link audit confirms that every named local document resolves. OSS Issues #161–#169 and Platform #134 resolve and remain open. PR #160 and PR #170 resolve and remain draft/unmerged. Issue [#172](https://github.com/nickconstantinou/agent-bridge/issues/172) is closed as duplicate because PR #160 became the owner of the full current-architecture rewrite. Closed, duplicate and plan-only work is labelled rather than presented as active runtime authority.

## Documentation reconciliation

Slice 0 changes:

- this reconciliation and issue map;
- `docs/roadmap/issue-159-role-based-orchestration.md` with actual issues, separate delivery/runtime order and stale-check invalidation;
- parent Issue #159 body and final evidence comments.

The canonical implementation plan is owned and inherited unchanged from PR #160. The ADR, canonical architecture, prompt/red-test contract, `agentic-maintenance.yaml` and `AGENTS.md` remain unchanged by PR #170.

At the original Slice 0 base, `docs/architecture/01-current-architecture.md` contained historical metadata, so #172 was created rather than applying a misleading header-only correction. PR #160 later performed the substantive rewrite and became the sole owner; #172 was closed as duplicate. PR #160 remains draft and independently gated.

## Verification and evidence policy

Slice 0 evidence must distinguish checks that ran from checks that were not scheduled. “CI passed” is not acceptable when only Architecture Lint ran.

At each final head record:

- exact stacked base, head, merge base and ahead/behind result;
- changed-path allowlist;
- local `git diff --check` result;
- local Architecture Lint result;
- every GitHub check name/conclusion associated with that exact SHA;
- workflows that did not run;
- path/link classification and residual risk;
- independent-review identity or independence description.

A same-model review is non-independent. Any source correction invalidates old exact-head verification and review evidence.

## Human approval gate

Slice 0 is ready for maintainer review only when all deterministic local checks and a genuinely independent review complete without an unresolved blocker. Until then:

- Issue #159 remains open;
- PR #160 and PR #170 remain draft and unmerged;
- Slice 1/#161 remains blocked;
- no deployment, restart, database, service, queue, production checkout or Platform runtime mutation is permitted.

## Bounded retrospective

Two process defects were identified:

1. long-lived plans can drift from current repository ownership and active dependencies;
2. a numbered delivery graph can be mistaken for runtime phase order when the invariant is copied across long issue specifications.

The correction is local: exact-head owner reconciliation, dependency/non-overlap recording, separate delivery/runtime diagrams, complete stale-evidence invalidation and a pre-mutation cross-slice invariant audit. Existing `AGENTS.md` rules already require the underlying discipline, so no duplicate global rule is added.
