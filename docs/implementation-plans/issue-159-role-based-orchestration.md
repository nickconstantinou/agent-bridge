# Implementation Plan — Issue #159 Role-Based Agentic Orchestration

## Status and authority

Approved epic implementation handoff for a sequence of independently reviewable child pull requests.

This document is not an instruction to implement Issue #159 in one branch. Every behavioural slice requires its linked child issue, isolated workspace, characterization where needed, test-only red commit, separate green commit, exact-head verification, review, documentation completion, fresh final re-review, and human merge decision.

The accepted ADR, canonical architecture, current repository evidence, prompt/skill contract, and human gates are normative. Do not weaken the architecture merely to fit current code.

PR #160 supplies prompt, lifecycle-skill, plan-validation, documentation-policy, and schema foundations. It does not activate role assignment or role-based routing.

## Objective

Implement exactly three configurable Engineering Worker roles:

- **Technical Lead** — requirements discovery and validation, canonical issue authoring, multi-issue decomposition review, implementation planning, bounded executor guidance, implementation review, operations review, and PR readiness;
- **Code Worker** — read-only defect/refactor scanning and investigation, mechanically separated red/green implementation, bounded repair, and verification;
- **Documentation Steward** — documentation impact, documentation-only authoring, maintenance, and validation.

The canonical runtime workflow is:

```text
validated requirements
→ approved canonical GitHub issue
→ Technical Lead implementation plan
→ bounded Code Worker red/green/repair
→ deterministic verification
→ Technical Lead implementation review
→ Technical Lead operations review when triggered
→ Documentation Steward authoring and validation
→ Technical Lead PR readiness
→ exact-head CI
→ human merge gate
```

Implementation delivery order is not runtime phase order. Slice 7 builds a dormant Documentation Steward capability; Slice 8 activates review-before-documentation composition.

Agent Bridge remains authoritative for state, issue/PR mutation, prompts and skills, schemas, validators, evidence, tools, permissions, budgets, retries, cancellation, approvals, merge, deployment, and audit.

## Read first

- Issue #159 and child issues #161–#169;
- platform Issue #134;
- `AGENTS.md`;
- `agentic-maintenance.yaml`;
- `docs/adr/ADR-005-role-based-agentic-orchestration.md`;
- `docs/architecture/01-current-architecture.md`;
- `docs/architecture/engineering-worker.md`;
- `docs/architecture/agentic-worker-orchestration.md`;
- `docs/architecture/agentic-prompt-contracts.md`;
- `docs/agentic-maintenance.md`;
- `docs/configuration/agent-role-assignment.md`;
- `docs/operations/agentic-worker-runbook.md`;
- `docs/testing/agentic-worker-verification.md`;
- `docs/architecture/10-production-readiness.md`;
- `docs/implementation-plans/issue-159-prompt-and-red-test-contract.md`;
- Issues #100, #119, #132, #135, and #146;
- PRs #152, #157, #158, and #160 as applicable.

Use the repository requirements, risk-testing, TDD, release-readiness, and Git sandbox/worktree skills before editing.

## Working model

1. Reconcile the exact base, active PRs/issues, current owners, and real caller paths before planning.
2. Do not assume an imported issue, request, or scan finding is complete.
3. Surface product decisions instead of silently inventing them.
4. When work is split, assemble the complete proposed issue bundle before any GitHub mutation.
5. Run one bundle-wide invariant audit that separates implementation delivery order from runtime phase order.
6. Create plans only from `requirements_ready` canonical issues.
7. Classify every target production and test path from current evidence.
8. Put the strongest available reasoning target on requirements, architecture, planning, risk, and review.
9. Give the Code Worker immutable bounded packets, not broad ownership of the solution.
10. Start behavioural change with a production-boundary red test that fails for the intended reason.
11. Commit characterization, red tests, production implementation, repairs, and documentation separately as applicable.
12. Run deterministic verification before Technical Lead implementation and operations review.
13. Complete and validate all required documentation after accepted review and before readiness.
14. Treat code-changing repair as invalidating all later evidence for the prior head.
15. Perform independent review where policy requires it, fix blockers, rerun exact-head checks, and conduct a fresh final re-review.
16. Verify authoritative postconditions rather than intended actions or model claims.
17. Use disposable qualification before separately approved production rollout.
18. Preserve human authority over product decisions, material scope, merge, deployment, destructive operations, secrets, permissions, and policy exceptions.
19. End each non-trivial slice with a bounded defect-pattern retrospective.

## Non-negotiable invariants

1. Public roles are exactly `technical_lead`, `code_worker`, and `documentation_steward`.
2. Scanner is a Code Worker mode; review, operations, decomposition, and readiness are Technical Lead modes.
3. Role authority is independent of CLI/provider identity.
4. Technical Lead remains mutation-free through the existing `AdvisorService` boundary.
5. Code Worker permissions are mode-specific and enforced at real Bridge mutation boundaries.
6. Documentation Steward authoring is limited to manifest-approved documentation paths with deny precedence.
7. No plan exists before the exact canonical issue revision is `requirements_ready`.
8. No scan candidate becomes implementation work without Technical Lead disposition and canonical issue approval.
9. No multi-issue GitHub mutation occurs before a consistent bundle verdict.
10. Structured outputs are validated before persistence or use.
11. New/repaired plans reject invalid or unclassified target paths.
12. Models cannot override deterministic evidence or human gates.
13. Cancellation, lease loss, restart, retries, permission reduction, and auth revocation cannot duplicate calls or overwrite terminal state.
14. Existing red/green separation, disposable workspaces, PR-head checks, CI, and merge approval remain intact.
15. Implementation review occurs after deterministic verification and before documentation.
16. Documentation validation occurs before PR readiness.
17. A code-changing repair invalidates verification, review, operations, documentation, readiness, and CI evidence for the previous head.
18. Every required gate is bound to one exact `subject_head_sha`.
19. Required documentation that is missing, stale, contradictory, or misleading is fixed in the same delivery; it cannot be deferred while claiming readiness.
20. Legacy chains remain explicit compatibility inputs, not silent authority.
21. Desired platform state is not effective until the appliance reports the exact applied revision.
22. Invalid desired configuration never destroys the last valid effective assignment.
23. GitHub mutation is performed by Agent Bridge, never by a model.
24. Prompt and lifecycle-skill text remains source-controlled; database prompt precedence does not return.
25. No new direct SQL path, provider stack, process supervisor, workflow engine/state store, queue, GitHub mutation path, configuration transport, or merge path is introduced.

## Minimal-change strategy

Deliver a strangler extension of the current worker.

Retain:

- current work items, jobs, approvals, GitHub links, and repository-owned SQL;
- `BridgeDb` as compatibility façade and repository constructor/delegator;
- current handler map and registered task types;
- `jobExecutor` and `jobExecutorLoop` ownership, leases, retry, cancellation, and terminal fencing;
- `orchestrated_task` as initial role-orchestration host;
- `tdd_implementation` and mechanical red/green guards;
- disposable workspace creation and cleanup;
- `cliSupervisor` as sole child-process owner;
- provider adapters, registry, selection, and error classification;
- existing `AdvisorService`, fallback, redaction, budgets, and audit;
- implementation-plan validator and focused repair path;
- current GitHub issue/PR helpers and merge gate;
- current Telegram callbacks and captured-next-message pattern;
- current config loader and explicit legacy compatibility;
- Issue #135 strict production opener and guarded migration/rollback;
- current Architecture Lint ownership boundaries.

Add only focused capabilities:

- role and mode domain types;
- assignment and resolution revisions;
- a pure deterministic resolver;
- work-item source/canonical revisions and human decisions;
- role-aware phases within existing jobs;
- typed read-only evidence through AdvisorService;
- validated Technical Lead plans and immutable execution packets;
- dormant Documentation Steward policy/handler capability;
- Technical Lead review/operations/readiness phases;
- durable invocation identity and secret-safe audit where current records are insufficient;
- platform desired/effective status through existing bootstrap/reconciliation and heartbeat.

## Pre-mutation decomposition gate

When one request creates or updates multiple issues:

1. Author all proposed issue bodies without mutation.
2. Capture one canonical invariant table plus exact repository/dependency evidence.
3. Invoke `technical_lead:decomposition_review`.
4. Record implementation delivery order separately from runtime phase order.
5. Check current owners/callers, lifecycle/state authority, permissions, schema/SQL, GitHub mutation, platform/appliance authority, compatibility, repair invalidation, and duplicate abstractions.
6. Repair all missing or conflicting invariants and rerun review.
7. Permit Agent Bridge issue mutation only after `ready_for_issue_mutation`.

## Plan and red-test protocol

Every plan contains stable acceptance IDs, structured target paths, comprehensive `RedTestSpec` records, coverage matrices, bounded packets, documentation obligations, operations/rollback, and a compact execution contract.

Every target path is exactly one of:

- `existing_at_base`;
- `existing_in_dependency`;
- `proposed_new_production`;
- `proposed_new_test`.

Each target includes owner and rationale; dependency targets include the dependency PR and exact reviewed ref. Invalid or unclassified targets block new/repaired plans.

Already-persisted pre-provenance plans retain a narrow concrete-path compatibility validator. Newly generated and repaired model output always uses strict provenance validation.

For every red test, specify:

- stable test ID and mapped acceptance criteria;
- product and architecture intent;
- protected invariants and triggered risks;
- applicable test classes;
- characterization requirement;
- exact test file and test name;
- real production boundary and starting state;
- action through the actual caller;
- authoritative observable result;
- why current code fails;
- exact expected red assertion;
- focused command;
- sibling behaviour remaining green;
- authoritative oracle;
- false-positive controls.

The red commit contains tests/fixtures only, except a mechanically required non-behavioural fixture. It must fail for the intended missing behaviour. Green implements the smallest production change and does not modify committed red tests.

## Exact-head review and documentation protocol

Every verification, implementation review, operations review, documentation author/validation, readiness, and CI record identifies one `subject_head_sha`.

Required gate states are `passed`, `failed`, `not_run`, `not_scheduled`, `stale`, or `unknown`. Only authoritative `passed` evidence for the current head satisfies a required gate.

Required and actual review independence are separate. Same-model fresh-session review is non-independent.

After accepted implementation and applicable operations review, Documentation Steward corrects every triggered required document. A later issue, owner assignment, archive recommendation, or follow-up does not clear stale documentation. Material scope needed for correction produces a human-scope hold.

## Delivery slices

The list below is implementation delivery order.

### Slice 0 — reconciliation and child issues

Owner: parent #159 and stacked documentation work.

Deliver exact owner map, complete read-only issue bundle, bundle-wide invariant review, child issues #161–#169, platform #134, cross-repository interface, classified paths, and no production mutation.

Proof: documentation/issue diff, path/link audit, exact-head checks, and independent review. Slice 1 remains human-gated.

### Slice 1 — role domain, persistence, dormant status (#161)

Add exact role/mode parsing, additive assignment/revision persistence, and truthful configured-dormant status. Existing legacy chains and handlers remain effective.

Required red boundaries:

1. exactly three roles; mode names rejected as roles;
2. additive on-disk migration and reopen preserving current work/job data;
3. explicit desired assignment remains dormant while legacy policy remains effective;
4. seeded role rows cannot change any existing handler dispatch;
5. idempotent revision creation and secret-safe records.

### Slice 2 — capability discovery and deterministic resolution (#162)

Extend provider metadata and add a pure resolver; do not route handlers yet.

Required red boundaries include per-role model selection from one CLI, one-model degradation, ineligible target exclusion, stale-probe policy, deterministic ranking/ties, manual assignment safety, error-class fallback, malformed-output repair, and unchanged legacy fallback while disabled.

### Slice 3 — mode permission enforcement (#163)

Resolve a permission profile immediately before existing dispatch and reuse workspace/supervisor/environment owners.

Required red boundaries include Technical Lead mutation denial, read-only scans, test-only red, immutable red tests in green, packet-bounded repair, mutation-free verify, documentation deny precedence, child credential isolation, immediate revocation, and unchanged current TDD guards.

### Slice 4 — requirements and canonical GitHub issue lifecycle (#164)

Add intake phases around current work items, callbacks, repositories, and GitHub helpers; do not change implementation handlers.

Required red boundaries include detailed-issue validation, durable clarification without plan creation, defect facts versus hypotheses, unjustified refactor rejection, candidate non-promotion, exact verdict states, idempotent Bridge-owned GitHub reconciliation, human approval for material rewrite, external edit revalidation, restart-safe questions, split lineage, and unchanged current issue/callback behaviour.

Every split returns to the bundle-wide decomposition gate before child issue mutation.

### Slice 5 — Technical Lead evidence and planning (#165)

Extend existing AdvisorService/evidence broker; retain current plan validator and focused repair.

Required red boundaries include bounded allowlisted file evidence, traversal/symlink/shell/provider-tool/mutation rejection, typed Git evidence, provenance/freshness, cancellation fencing, `requirements_ready`, acceptance-to-packet traceability, classified targets, comprehensive red tests, documentation/operations/rollback, one bounded repair, fail-closed required advice, explicit degraded fallback, and unchanged current advisor/legacy planning behaviour while disabled.

### Slice 6 — scan candidates and immutable execution packets (#166)

Adapt current scans and feed approved packets into existing TDD/orchestrated handlers.

Required red boundaries include read-only evidence-rich candidates, no direct implementation enqueue, exact Technical Lead dispositions, idempotent split, immutable packet scope, no red/green/repair/verify scope expansion, exact executor evidence, one bounded guidance retry, restart without duplicate commits, and unchanged TDD/workspace/PR behaviour.

### Slice 7 — dormant Documentation Steward capability (#167)

Add policy and handler capabilities within the existing implementation workspace, but keep runtime orchestration dormant until Slice 8.

Required red boundaries include structured documentation impact, final-diff trigger evaluation, deterministic manifest classes, separate docs commit, allow/deny enforcement, missing/stale/contradictory document blocking, validated no-change rationale, code-defect return, restart without duplicate commits, and identical fallback permissions.

### Slice 8 — Technical Lead review, operations, and runtime composition (#168)

After deterministic verification, activate:

```text
implementation review
→ operations review when triggered
→ Documentation Steward author/validate
→ PR readiness
```

Required red boundaries include verification prerequisites, failed deterministic gate rejection, exact independence preference, isolated reused target, visible non-independence, high-risk hold, operations triggers and complete operational contract, exact-head equality, code-repair invalidation, stale-document blocking, and preservation of human merge/deploy authority.

### Slice 9 — lifecycle, audit, compatibility, rollout qualification (#169)

Extend current phase data, ownership fencing, and audit; do not replace outer job/queue semantics.

Required red boundaries include restart after each phase, idempotency budgets, cancellation and lease fencing, assignment changes at phase boundaries, auth/permission revocation, additive migration preserving active data, disabled-routing compatibility, safe rollback holds, exact prompt/skill/head lineage, serial/repeated race coverage, and no duplicate queue/supervisor/state/SQL path.

### Slice 10 — platform desired/effective role allocation (platform #134)

Platform owns desired role policy and revision; appliance owns auth, discovery, validation, effective resolution, degradation, last-known-valid state, and exact applied revision.

Required red boundaries include exact role/config schema, monotonic revisions, bootstrap schema/revision, heartbeat desired-versus-applied truth, invalid-application preservation, offline last-known-valid operation, UI modes and degradation visibility, one-CLI/model usability, non-mutating tests, no raw credentials, fail-safe version incompatibility, and no desired-equals-effective claim before matching heartbeat.

## Cross-repository rollout

1. Merge OSS schema/parser/status support with routing disabled.
2. Qualify additive OSS migrations and unchanged legacy flow.
3. Merge platform read-only effective-status support.
4. Merge platform desired configuration behind a disabled flag.
5. Deploy OSS compatibility before platform desired revisions become actionable.
6. Enable one disposable workspace.
7. Qualify single-CLI/model, multi-provider, invalid config, offline, cancellation, restart, migration, rollback, documentation, review, and readiness scenarios.
8. Enable selected beta workspaces only after approval.
9. Production-wide enablement and legacy retirement require separate evidence and approval.

Rollback stops new desired revisions, disables role routing, retains records, uses only explicitly approved legacy compatibility, and holds incompatible jobs rather than reinterpreting them.

## Verification for every child PR

At minimum:

- captured focused red failure for the intended reason;
- focused green command;
- affected subsystem suite;
- full `npm test`;
- `npm run typecheck`;
- `bash scripts/arch-lint.sh src`;
- `npm run cleanup:check` with pre-existing findings accounted for;
- `git diff --check`;
- migration/rollback tests where applicable;
- repeated/serial runs for lifecycle/shared-state risk;
- final changed-path, caller, sibling, provider, transport, and SQL-owner audit;
- documentation trigger evaluation and same-delivery correction;
- exact final head and exact-head GitHub Actions;
- implementation and applicable operations review;
- Documentation Steward validation;
- final PR-readiness review;
- actual independence level;
- residual risk and retrospective.

A check that was not run or not scheduled must be reported exactly that way. It cannot be described as green.

## Human gates

Human approval remains required for:

- the Slice 0 decomposition and permission to begin Slice 1;
- unresolved product decisions;
- material issue or scope changes;
- required independence policy exceptions;
- merge;
- production database migration, deployment, or restart;
- destructive operations;
- secrets or permissions;
- policy exceptions.

## Completion

Issue #159 completes only when all linked OSS/platform slices are implemented and independently reviewed to required policy; exact-head deterministic, review, operations, documentation, and CI evidence passes; every required document is current; prompt/skill identities are durable and secret-safe; migration and rollback are qualified; legacy prompt overrides remain absent; compatibility retirement is explicit; and no blocker remains.
