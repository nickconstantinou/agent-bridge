# Agentic Worker Operations Runbook

## Status

Canonical operating runbook for role-based Engineering Worker orchestration. Target-state procedures apply only after their owning Issue #159 slices are implemented and enabled.

## Scope

This runbook covers role configuration, target validation, workflow observation, safe degradation, cancellation, restart recovery, exact-head evidence, documentation blocking, and rollback. It does not authorise issue mutation, merge, deployment, secret changes, service restart, or destructive operations without the existing human gates.

## Preflight

Before enabling role-based orchestration:

1. Confirm the worker service and database are healthy.
2. Confirm every configured CLI reports authenticated status through its authoritative provider probe.
3. Confirm every assigned model has a fresh successful capability probe.
4. Confirm the effective role matrix has a Technical Lead, Code Worker, and Documentation Steward.
5. Confirm each effective permission profile matches the role mode.
6. Confirm `agentic-maintenance.yaml` exists and every referenced canonical document exists and is current.
7. Confirm focused decomposition, role-resolution, permission, lifecycle, migration, exact-head, and documentation-gate tests pass.
8. Confirm the full suite, typecheck, Architecture Lint, cleanup/static checks, `git diff --check`, and exact-head GitHub Actions pass.
9. Confirm a read-only Technical Lead advisor lane is available for a fresh exact-head final review independent from the mutating Code Worker.
10. Record the exact application SHA, reviewer role/authority basis, model-diversity state, backup prerequisites, and rollback path.

## Issue-mutation preflight

For work that creates or updates multiple child issues:

1. Assemble every proposed issue body without mutation.
2. Capture current owner/caller, dependency, and canonical invariant evidence.
3. Run `technical_lead:decomposition_review` over the complete bundle.
4. Confirm implementation delivery order and runtime phase order are separately recorded.
5. Resolve every invariant conflict, overlap, missing lifecycle edge, unclassified path, and unresolved product decision.
6. Permit Agent Bridge GitHub mutation only after `ready_for_issue_mutation`.

A partial mutation followed by later consistency review is an operational defect. Retry and remote/local interruption handling must remain idempotent.

## Effective status

Operators use the role status surface to inspect:

- requested and effective CLI/model per role;
- fallbacks and configuration source;
- authentication and model-probe status;
- role permission profile;
- call and time budgets;
- required and actual review-independence basis;
- reviewer role, target, mutation separation, and fresh-invocation state;
- model-diversity state as separate metadata;
- legacy-chain compatibility state;
- active workflow phase and authoritative owner;
- exact subject head for current verification/review/documentation evidence.

Status and probe operations are read-only. Reconciliation is a separate explicit mutation.

## Safe enablement

1. Persist or approve role assignments.
2. Run non-mutating role probes.
3. Enable role orchestration for one disposable test workspace or repository.
4. Import or create a low-risk feature, defect, and refactor sample.
5. Verify every input passes requirements validation before planning.
6. Verify a multi-issue sample cannot mutate GitHub before bundle review.
7. Verify new plans require structured target provenance and comprehensive red tests.
8. Verify scan calls are read-only and documentation authoring is path-restricted.
9. Verify red and green phases retain mechanical file separation.
10. Verify deterministic verification precedes implementation review.
11. Verify implementation and applicable operations review precede documentation.
12. Verify all later evidence is bound to one exact head.
13. Verify stale required documentation blocks readiness until corrected.
14. Verify a read-only Technical Lead can review Code Worker output independently even when the same frontier model is reused.
15. Verify the Code Worker cannot review its own mutation.
16. Expand enablement only after evidence is recorded.

## Operational evidence

A qualified workflow records:

- work item and job IDs;
- canonical issue version and `requirements_ready` transition;
- decomposition-review evidence and mutation verdict for multi-issue work;
- classified target-path provenance;
- role, mode, CLI, model, and permission profile for every logical call;
- prompt and lifecycle-skill identities;
- advisor/tool audit without secrets;
- red and green commit SHAs;
- deterministic verification output and timestamps;
- exact `subject_head_sha` for verification, review, operations, documentation, readiness, CI, and final review;
- gate state as `passed`, `failed`, `not_run`, `not_scheduled`, `stale`, or `unknown`;
- required and actual review-independence basis;
- reviewer role and target;
- whether the reviewer authored or modified the reviewed implementation;
- whether mutation authority was available in the review invocation;
- whether the review was a fresh exact-head invocation;
- model-diversity state reported separately;
- documentation-impact result, corrected documents, and validation;
- Technical Lead implementation, operations, readiness, and final-review verdicts;
- human approvals;
- retrospective result.

Only authoritative `passed` evidence for the exact current head satisfies a required gate.

## Common degraded states

### Only one CLI authenticated

Expected behaviour:

- Agent Bridge selects a model independently for each role;
- role prompts, sessions, permissions, and budgets remain separate;
- status reports the single-provider dependency;
- work continues when each role capability and the Technical Lead/Code Worker authority boundary are satisfied.

Action when blocked: authenticate another supported CLI only when a required role capability is unavailable. A second CLI is not required solely to create review independence.

### Only one model available

Expected behaviour:

- role and permission separation remains active;
- Technical Lead review runs through the read-only advisor path in a fresh exact-head invocation;
- actual independence is recorded as `technical_lead_role_independent` when the Technical Lead did not author or modify the implementation and has no mutation authority;
- model diversity is recorded as unavailable;
- work does not pause merely because a second model is unavailable.

The same frontier model may serve Technical Lead and Code Worker roles. Role and authority separation, deterministic evidence, exact-head freshness, and the human merge gate remain the controls.

### Technical Lead unavailable

Requirements, decomposition review, planning, and review do not fall through silently to an arbitrary Code Worker. The workflow either:

- uses an explicitly configured Technical Lead fallback;
- uses an explicitly enabled legacy compatibility path where the phase permits it and reports degradation; or
- pauses for operator action.

### Documentation Steward unavailable

Implementation and accepted review evidence may remain durable, but PR readiness stays blocked when manifest triggers require documentation. An explicitly configured fallback may satisfy the role only under the same documentation-only policy.

Do not create a follow-up issue as a substitute for correcting required stale documentation.

### Code Worker unavailable

Requirements and planning may complete, but no mutating implementation phase begins. The work item remains resumable and reports the missing effective worker target.

## Code-changing repair invalidation

Any code-changing repair after deterministic verification invalidates, for the previous head:

- deterministic verification;
- implementation review;
- operations review;
- documentation authoring;
- documentation validation;
- PR readiness;
- exact-head CI evidence;
- final Technical Lead review.

After the repair:

1. record the new head;
2. rerun deterministic verification;
3. rerun implementation and applicable operations review;
4. update and validate required documentation against the new head;
5. rerun PR readiness and exact-head CI;
6. perform a fresh exact-head read-only Technical Lead final review.

Do not reuse earlier evidence merely because the repair was described as small.

## Documentation blocking and recovery

When documentation validation reports a missing, stale, contradictory, or materially misleading required document:

1. keep the readiness verdict non-ready;
2. identify the manifest trigger and authoritative final evidence;
3. grant Documentation Steward authoring only for approved documentation paths;
4. correct the document in the same delivery;
5. rerun documentation validation for the exact current head;
6. rerun readiness, exact-head checks, and final Technical Lead review as required by the changed head.

A deferred issue, owner assignment, archive suggestion, or roadmap entry does not clear the blocker.

When the required correction would materially change product, architecture, authority, or approved scope, hold for human scope approval. This is a blocking hold, not an accepted deferral.

## Cancellation

Cancellation prevents new role calls and revokes owned in-flight capabilities. Terminal job state cannot be overwritten by late model output.

Verify after cancellation:

- no new logical call starts;
- owned provider attempts terminate within the bounded timeout;
- active worktree processes stop through the existing supervisor path;
- authoritative job state is `cancelled`;
- restart does not resume cancelled work;
- no documentation or GitHub mutation occurs after cancellation.

## Restart and lease recovery

On restart:

1. Reconcile authoritative job and phase state.
2. Recover or fail stale role attempts according to lifecycle policy.
3. Preserve task-wide logical-call budgets.
4. Do not repeat a completed phase whose output remains authoritative for the current head.
5. Treat prior-head verification/review/documentation as stale after a code change.
6. Revalidate target authentication and model probes before a new call.
7. Resume only from an authoritative durable transition.

A stale worker or lost lease cannot dispatch a duplicate role call or persist late output.

## Permission incident

If a role receives or attempts an unauthorised capability:

1. Stop the workflow and revoke the capability.
2. Preserve original evidence and role audit.
3. Confirm no unauthorised file, Git, GitHub, service, database, or production mutation occurred.
4. Restore repository state from the protected baseline if necessary.
5. Record the incident and open a defect with a boundary-level regression test.
6. Do not resume until permission mapping and enforcement tests are fixed.

## Rollback

Role-orchestration rollback returns routing to the prior worker chain without deleting new durable records.

Rollback sequence:

1. Stop new intake or drain the worker safely.
2. Capture exact application SHA, database backup, effective role configuration, and active job inventory.
3. Disable role routing through the approved configuration switch.
4. Retain role assignments and audit rows for forward recovery.
5. Restore legacy routing only when explicitly configured and validated.
6. Restart through the approved drain/restart procedure.
7. Verify worker health, queue ownership, status projection, and zero duplicate jobs.
8. Hold jobs whose requirements, plan provenance, or lifecycle state cannot be interpreted safely by the legacy path.

## Post-change verification

For production or appliance rollout, verify:

- exact deployed commit and artifact equality;
- service active state;
- worker queue and lease health;
- effective role assignments and configuration sources;
- authentication probes without credential leakage;
- no duplicate role calls after restart;
- all canonical documents exist and are current;
- sample read-only scan and role status;
- rollback snapshot integrity;
- exact-head evidence and Technical Lead role-separation review policy.

## Escalation conditions

Stop and request human action when:

- a product decision remains unresolved;
- a multi-issue bundle remains inconsistent;
- requirements validation cannot distinguish safe interpretations;
- a target path is invalid or unclassified;
- a role target lacks enforceable permissions;
- model or CLI authentication is ambiguous;
- no read-only Technical Lead review lane is available;
- the proposed reviewer authored or modified the implementation or has mutation authority;
- lifecycle ownership is stale or conflicting;
- deterministic evidence conflicts with model output;
- required documentation cannot be corrected within approved scope;
- rollout or rollback postconditions cannot be verified.
