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

This record completes Slice 0 only. It reconciles the accepted Issue #159 architecture and implementation plans against exact repository evidence, records the current authoritative owners, and links implementation Slices 1–10.

It does not authorize Slice 1, merge PR #160, merge this stacked PR, deploy, restart, mutate a database, change a service, or alter Platform runtime configuration.

For current owners, likely target files, dependencies and overlap decisions, this record supersedes stale guesses in older planning material. The accepted ADR, product decisions, canonical runtime workflow, prompt/red-test contract and human gates remain unchanged.

## Reconciled baseline

| Item | Exact evidence |
|---|---|
| OSS repository | `nickconstantinou/agent-bridge` |
| OSS `main` used by PR #160 | `1ce03d5e22ec44b3b23fef847b273f2bce08303c` |
| PR #160 branch | `agent/role-based-worker-orchestration-docs` |
| PR #160 exact head / stacked base | `db2ab80f6895bad76cdf46930790bfe70691408a` |
| PR #160 state | open, draft, unmerged |
| Platform repository | `nickconstantinou/agent-bridge-platform` |
| Platform `main` used for reconciliation | `31d6b5e42b89eeb433e272816fd6bbb7aced2dce` |
| Slice 0 branch | `agent/issue-159-slice-0-decomposition` |
| Slice 0 stacking | created from the exact PR #160 head; PR #170 targets the PR #160 branch |

PR #160 remains the delivered runtime/schema/prompt foundation. It already supplies the source-controlled role/mode prompts, canonical lifecycle-skill composition, comprehensive red-test contract, plan-quality strengthening, source-only prompt resolution, schema version 2 and guarded legacy prompt-table removal. Later slices extend those owners and must not recreate a prompt service, AdvisorService, worker execution stack or migration authority. Its current exact head also includes the pre-mutation Technical Lead decomposition-review prompt, stronger target-path provenance checks and the full current-architecture rewrite. The move from the original Slice 0 base to `db2ab80f6895bad76cdf46930790bfe70691408a` comprises 36 commits, modifies or adds 34 paths and deletes none, so every previously classified exact-base implementation target remains present; the classification was re-anchored to the new exact base.

## Relevant work and non-overlap

| Work | Current role in Issue #159 |
|---|---|
| #100 / PR #152 | sole bounded Advisor read-only evidence-broker and blocked-worker debug owner; extended by Slice 5, not duplicated |
| #119 / PR #120 | closed issue and plan-only historical lifecycle design input; current executor/repository/supervisor owners remain authoritative |
| #132 | Advisor checkpoint budgets and risk-gate dependency for planning/review |
| #135 / PR #158 | strict database boundary and guarded migration/rollout owner |
| #146 | evidence authority/freshness dependency |
| #35 | scan-trigger dependency only; Slice 6 owns candidate disposition and approved execution |
| PR #157 | existing focused execution-contract repair path |
| Platform #72/#93/#95/#96/#119 | existing runtime, worker-surface, fleet, frontend and immutable-deployment dependencies; none owns the three-role desired/effective protocol |

No exact active implementation owner was found for any Slice 1–10 responsibility. Every partial overlap is a linked dependency with an explicit non-overlap boundary.

## Current authoritative owner map

| Concern | Current owner | Planned focused extension |
|---|---|---|
| role domain | accepted contracts only | `src/agentRoles.ts` in #161 |
| worker configuration | `src/config.ts`, `src/workerCliPolicy.ts` | dormant desired assignment in #161; effective resolution in #162 |
| schema/migrations | `src/db/schema.ts`, numbered migration modules, Issue #135 | additive numbered migrations only when proven necessary |
| SQL/repositories | `src/repositories/**`, constructed/delegated by `BridgeDb` | focused repositories only where no current owner fits |
| status projection | `src/workerBot.ts`, composed by `src/index-worker.ts` | desired/dormant/effective/audit projection in #161/#162/#169 |
| provider/model metadata | `src/providers/types.ts`, registry, selection and runtimes | role capability inputs in #162 |
| role resolution | current legacy worker chains only | pure `src/roleResolution.ts` in #162 |
| permission enforcement | dispatch, CLI, sole supervisor, workspace, TDD/job/merge boundaries | `src/workerPermissionProfile.ts` in #163; existing boundaries enforce it |
| requirements/canonical issue | worker intake/callbacks, `WorkQueueRepository`, GitHub issue handler | immutable revisions/lifecycle/reconciliation in #164 |
| Advisor evidence | existing `AdvisorService`; PR #152 broker/redaction/audit | planning evidence modes through the same boundary in #165 |
| implementation planning | current plan handler, quality validator, prompt/skill registries | Technical Lead plan coordinator only if needed in #165 |
| TDD execution | current TDD/orchestrated handlers, workspace and Git guards | immutable packet/profile enforcement in #163/#166 |
| scans | current defect/refactor scan handlers | candidate/disposition contract in #166 |
| documentation | `agentic-maintenance.yaml`, workspace/job/PR lifecycle | dormant policy/handler capability in #167 |
| implementation/operations/readiness review | deterministic checks, Advisor checkpoints, PR lifecycle and merge gate | `src/technicalReviewPolicy.ts` and sequence composition in #168 |
| jobs/restart/cancellation | executor, executor loop, work repository, sole supervisor | cross-phase qualification in #169 |
| audit | Advisor/run/job records; events remain projections | focused invocation lineage only where current records are insufficient in #169 |
| GitHub mutation | current issue/PR helpers, repository links and human merge gate | approved-revision reconciliation in #164; models never mutate GitHub |
| Platform desired state | current control-plane store/types/service/runtime/frontend | `src/control-plane/roleAllocation.ts` in Platform #134 |
| appliance effective state | OSS auth/discovery/resolution/status/heartbeat | #162/#169, consumed by Platform only after compatibility evidence |
| rollout/rollback | Issue #135/PR #158 and existing immutable Platform deployment | OSS #169 before Platform #134 |

Prohibited duplicates remain explicit: no second queue, workflow engine, process supervisor, workspace manager, provider stack, AdvisorService, prompt store, SQL path, GitHub mutation path, configuration transport, event-sourced state authority or merge path.

## Child issue map

| Slice | Repository | Issue | Primary responsibility |
|---:|---|---|---|
| 1 | agent-bridge | [#161](https://github.com/nickconstantinou/agent-bridge/issues/161) | role domain, additive assignment persistence and dormant status; no routing |
| 2 | agent-bridge | [#162](https://github.com/nickconstantinou/agent-bridge/issues/162) | capability discovery and deterministic effective resolution; no handler routing |
| 3 | agent-bridge | [#163](https://github.com/nickconstantinou/agent-bridge/issues/163) | Bridge-enforced role-mode permissions at existing mutation boundaries |
| 4 | agent-bridge | [#164](https://github.com/nickconstantinou/agent-bridge/issues/164) | requirements, durable decisions and canonical GitHub issue reconciliation |
| 5 | agent-bridge | [#165](https://github.com/nickconstantinou/agent-bridge/issues/165) | extend PR #152 evidence into Technical Lead planning; no duplicate AdvisorService |
| 6 | agent-bridge | [#166](https://github.com/nickconstantinou/agent-bridge/issues/166) | scan candidates, dispositions and immutable Code Worker packets through existing handlers |
| 7 | agent-bridge | [#167](https://github.com/nickconstantinou/agent-bridge/issues/167) | build a dormant Documentation Steward policy/handler capability in the existing workspace; do not activate documentation execution |
| 8 | agent-bridge | [#168](https://github.com/nickconstantinou/agent-bridge/issues/168) | compose and activate Technical Lead review before documentation, then final readiness |
| 9 | agent-bridge | [#169](https://github.com/nickconstantinou/agent-bridge/issues/169) | cross-phase lifecycle, audit, compatibility, migration and rollout qualification |
| 10 | agent-bridge-platform | [#134](https://github.com/nickconstantinou/agent-bridge-platform/issues/134) | Platform desired revisions and desired/effective API/UI/status through the existing transport |

Every issue contains product and architecture intent, current owners, prohibited duplicates, concrete likely target paths, binary acceptance criteria, production-boundary red tests, coverage matrices, migration/rollback, documentation triggers, verification and human gates.

## Implementation delivery order

The numbered dependency graph below is **implementation delivery order**, not runtime phase order. Slice #167 is delivered before #168 only so #168 can compose the already-built dormant Documentation Steward capability.

```text
PR #160 foundation
  |
  v
#161 role domain/persistence/dormant status
  |
  v
#162 capability discovery/resolution
  |
  v
#163 permission enforcement
  |
  v
#164 requirements/canonical issue
  |
  +------------------------------+
  |                              |
  |       #100 / PR #152         |
  |       #132 and #146          |
  |              |               |
  +------------> #165 Technical Lead planning
                     |
                     v
                  #166 candidates/packets
                     |
                     v
                  #167 dormant Documentation Steward capability
                     |
                     v
                  #168 review-before-documentation activation/readiness
                     |
                     v
#135 / PR #158 --> #169 lifecycle/audit/compatibility/rollout
                     |
                     v
       agent-bridge-platform #134 desired/effective allocation
          (also depends on Platform #72/#93/#95/#96/#119)
```

No later slice may be pulled into an earlier issue. Each slice remains human-gated.

## Canonical runtime order

Runtime composition is independent of the numbered delivery order:

```text
deterministic verification
→ Technical Lead implementation review
→ Technical Lead operations review when triggered
→ Documentation Steward authoring and validation
→ Technical Lead PR-readiness advisory
→ exact-head checks and human merge gate
```

The following are mandatory:

- Slice #167 must not activate Documentation Steward execution in the production workflow.
- Slice #168 owns activation of review-before-documentation and final readiness composition.
- Documentation authoring requires accepted Technical Lead implementation review and any required operations review bound to the same exact code head.
- A code-changing repair invalidates deterministic verification, implementation/operations review, documentation and readiness evidence until the required phases rerun against the new head.
- Slice #169 qualifies this exact sequence across restart, retry, cancellation, lease loss, stale evidence, fallback, migration and rollback.

The accepted ADR and canonical architecture are not changed to mirror slice numbering.

## Cross-repository desired/effective contract

Platform owns desired policy, immutable monotonic desired revisions, authorization, history and delivery through the existing bootstrap/reconciliation path.

The appliance owns authentication, capability probes, validation, deterministic resolution, permissions, degradation/rejection, last-known-valid effective state and exact applied revision.

The existing authenticated appliance heartbeat is extended—not replaced—to report contract version, desired revision observed, exact applied revision, `pending|applied|degraded|rejected`, effective targets, bounded reasons, freshness, review independence/degradation, timestamp and last-known-valid revision. It contains no credentials or raw prompts/evidence.

Platform may report `applied` or `degraded` only when an authenticated heartbeat reports an `appliedRevision` exactly matching the current desired revision. An older, absent, stale or rejected result cannot erase or impersonate last-known-valid effective state.

OSS Slices 1–9 must be merged, deployed and disposable-appliance qualified before Platform #134 may issue actionable desired revisions. No new transport, auth mechanism, resolver, runtime writer or secrets store is introduced.

## Pre-mutation cross-slice invariant audit

For future Slice 0-style decomposition, proposed child issue bodies must be assembled as a read-only bundle **before** GitHub issue creation or mutation. The bundle is reviewed against one canonical invariant matrix covering:

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

Only after the matrix is internally consistent may issue mutation begin. This local process prevents numbered implementation order from being mistaken for runtime execution order. It does not require another `AGENTS.md` rule because the repository already requires current-state investigation, architecture preservation, production-boundary verification and retrospectives.

## Reproducible path and link classification

The classification input is every concrete implementation target path in the current-owner/target-file sections of the three Slice 0 documents, OSS Issues #161–#169 and Platform Issue #134. Generic descriptions such as “existing tests”, documentation references, globs and command names are not counted as implementation targets. Local documentation paths are validated separately by exact-head file lookup.

Paths are deduplicated by repository and exact string, then classified against these immutable references:

- OSS base: `db2ab80f6895bad76cdf46930790bfe70691408a`;
- dependency PR #152 head: `35c6a1a988e4cf197ca71cf2a653f103156e75e7`;
- Platform base: `31d6b5e42b89eeb433e272816fd6bbb7aced2dce`.

The read-only audit uses repository file lookup at the exact base for existing paths, PR #152's changed-file list for dependency-only paths, and the issue's explicit owner/rationale for proposed files.

| Category | Result |
|---|---:|
| 1. Exists at exact OSS or Platform base | 67 |
| 2. Exists in explicitly named dependency PR #152 | 10 |
| 3. Proposed new production path with owner/rationale | 23 |
| 4. Proposed new test path | 33 |
| 5. Invalid or unclassified | **0** |
| Total concrete path references after deduplication | 133 |

Category 2 is limited to the PR #152 Advisor evidence/broker/blocked-result production and test files. Category 3 includes focused role, resolver, permission, requirements, planning, candidate, documentation, review, compatibility/audit and Platform allocation owners. Category 4 consists only of explicitly proposed tests. Optional paths remain optional and must be revalidated at the exact starting head of their implementing slice; this classification does not pre-authorize their creation.

The exact-head documentation-link audit confirms that every local document named by the roadmap, implementation plan and reconciliation record resolves, including the ADR, canonical architecture, prompt contracts, configuration, runbook, testing, maintenance, roadmap and all three implementation-plan files. The GitHub link/state audit confirms that OSS Issues #161–#169 and Platform Issue #134 resolve and remain open. PR #160 and PR #170 resolve and remain draft/unmerged. Issue [#172](https://github.com/nickconstantinou/agent-bridge/issues/172) is closed as a duplicate because PR #160 became the exact owner of the full current-architecture rewrite while Slice 0 was in progress. Reused dependencies are named with their actual owner role; closed, duplicate or plan-only work is labelled rather than presented as current runtime authority.

## Documentation reconciliation

### Documents changed by Slice 0

- this current-state reconciliation and issue map;
- `docs/roadmap/issue-159-role-based-orchestration.md` with actual issues, explicit delivery order and separate runtime order;
- parent Issue #159 receives final links/evidence and remains open.

The canonical implementation plan was rewritten directly in the advancing PR #160 foundation and is therefore inherited unchanged at this exact stacked base rather than overwritten by PR #170.

### Documents deliberately unchanged

- `docs/implementation-plans/issue-159-role-based-orchestration.md` — current PR #160 owner already contains the corrected workflow, decomposition gate, target provenance and child-slice contracts;
- `docs/adr/ADR-005-role-based-agentic-orchestration.md` — accepted architecture remains valid;
- `docs/architecture/agentic-worker-orchestration.md` — no genuine architecture correction was found;
- `docs/implementation-plans/issue-159-prompt-and-red-test-contract.md` — contract remains valid at the current foundation;
- `agentic-maintenance.yaml` — existing mapping covers the Slice 0 documentation diff;
- `AGENTS.md` — existing global rules cover the process defect.

### Current-architecture revalidation owner

At the original Slice 0 base, `docs/architecture/01-current-architecture.md` still contained historical branch/draft metadata, so follow-up Issue [#172](https://github.com/nickconstantinou/agent-bridge/issues/172) was created rather than applying a misleading header-only correction. During this review, PR #160 advanced to exact head `db2ab80f6895bad76cdf46930790bfe70691408a` with a substantive full-document current-architecture rewrite. PR #160 is therefore the existing owner; #172 is closed as a duplicate to avoid parallel authority. PR #160 remains draft and its rewritten architecture document still requires exact-current-head evidence and genuinely independent review before approval.

## Verification and evidence policy

Slice 0 completion evidence must distinguish checks that actually ran from checks that were not scheduled. “CI passed” is not acceptable when only Architecture Lint ran.

At each final head, record:

- exact stacked base, head, merge base and ahead/behind result;
- exact changed-path allowlist;
- local `git diff --check` result;
- local Architecture Lint result;
- every GitHub check name/conclusion associated with that exact SHA;
- workflows that did not run;
- path/link classification and remaining residual risk;
- independent-review identity or independence description.

A same-model review is non-independent. Any source correction invalidates old exact-head verification and review evidence.

## Human approval gate

Slice 0 is complete only for review when all deterministic local checks and a genuinely independent review have completed without an unresolved blocker. Until then:

- Issue #159 remains open;
- PR #160 and PR #170 remain draft and unmerged;
- Slice 1/#161 remains blocked;
- no deployment, restart, database, service, queue, production checkout or Platform runtime mutation is permitted.

## Bounded retrospective

Two process defects were identified:

1. long-lived plans can drift from current repository ownership and active dependencies;
2. a numbered delivery graph can be mistaken for runtime phase order when the same invariant is copied across long issue specifications.

The correction is local and concrete: exact-head owner reconciliation, dependency/non-overlap recording, separate delivery/runtime diagrams, and a pre-mutation cross-slice invariant audit. Existing `AGENTS.md` rules already require the underlying discipline, so no duplicate global rule is added.
