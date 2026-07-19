# Agentic Worker Operations Runbook

## Status

Canonical operating runbook for role-based Engineering Worker orchestration.

## Scope

This runbook covers role configuration, target validation, workflow observation, safe degradation, cancellation, restart recovery, and rollback. It does not authorise merges, deployments, secret changes, or destructive operations without the existing human gates.

## Preflight

Before enabling role-based orchestration:

1. Confirm the worker service and database are healthy.
2. Confirm every configured CLI reports authenticated status through its authoritative provider probe.
3. Confirm every assigned model has a fresh successful capability probe.
4. Confirm the effective role matrix has a Technical Lead, Code Worker, and Documentation Steward.
5. Confirm each effective permission profile matches the role mode.
6. Confirm the repository contains `agentic-maintenance.yaml` and every referenced canonical document exists.
7. Confirm focused role-resolution, migration, lifecycle, and permission tests pass.
8. Confirm exact-head CI, typecheck, Architecture Lint, and the full test suite pass.

## Effective status

Operators use the role status surface to inspect:

- requested and effective CLI/model per role;
- fallbacks and configuration source;
- authentication and model-probe status;
- role permission profile;
- call and time budgets;
- model-diversity and independent-review state;
- legacy-chain compatibility state;
- active workflow phase and authoritative owner.

Status and probe operations are read-only. Reconciliation is a separate explicit mutation.

## Safe enablement

1. Persist or approve role assignments.
2. Run non-mutating role probes.
3. Enable role orchestration for one test workspace or repository.
4. Import or create a low-risk feature, defect, and refactor sample.
5. Verify each input passes requirements validation before planning.
6. Verify scan calls are read-only and documentation authoring is path-restricted.
7. Verify red and green Code Worker phases retain mechanical file separation.
8. Verify Technical Lead review reports independence accurately.
9. Verify required documentation triggers are resolved before PR readiness.
10. Expand enablement only after evidence is recorded.

## Operational evidence

A qualified workflow records:

- work item and job IDs;
- canonical issue version and `requirements_ready` transition;
- role, mode, CLI, model, and permission profile for every logical call;
- advisor/tool audit without secrets;
- red and green commit SHAs;
- deterministic verification output and timestamps;
- documentation-impact result and changed documents;
- Technical Lead review and operations verdicts;
- PR head SHA and CI state;
- human approvals;
- retrospective result.

## Common degraded states

### Only one CLI authenticated

Expected behaviour:

- Agent Bridge selects a model independently for each role;
- role prompts, sessions, permissions, and budgets remain separate;
- status reports the single-provider dependency;
- work continues when each role capability is satisfied.

Action when blocked: authenticate another supported CLI or manually assign a verified model exposed by the existing CLI.

### Only one model available

Expected behaviour:

- role and permission separation remains active;
- Technical Lead review runs in a fresh isolated session;
- status reports model diversity and independent-model review as unavailable;
- high-risk work pauses only when repository policy requires independent-model review.

### Technical Lead unavailable

Requirements and planning do not fall through silently to an arbitrary Code Worker. The workflow either:

- uses an explicitly configured Technical Lead fallback;
- uses a deliberately enabled legacy scribe compatibility path and marks the result legacy/degraded; or
- pauses for operator action.

### Documentation Steward unavailable

The workflow may continue through implementation, but PR readiness remains blocked when the document manifest triggers updates. An explicitly configured fallback may satisfy the role under the same documentation-only policy.

### Code Worker unavailable

Requirements and planning may complete, but no mutating implementation phase begins. The work item remains resumable and reports the missing effective worker target.

## Cancellation

Cancellation prevents new role calls and revokes owned in-flight role capabilities. Terminal job state cannot be overwritten by late model output.

Verify after cancellation:

- no new logical call starts;
- owned provider attempts terminate within the bounded timeout;
- active worktree processes are stopped through the existing supervisor path;
- the authoritative job state is `cancelled`;
- a restart does not resume cancelled work;
- no documentation or GitHub mutation occurs after cancellation.

## Restart and lease recovery

On restart:

1. Reconcile authoritative job and phase state.
2. Recover or fail stale role attempts according to Issue #119 lifecycle rules.
3. Preserve the task-wide logical-call budget.
4. Do not repeat a completed requirements, planning, review, or documentation step.
5. Revalidate target authentication and model probes before starting a new call.
6. Resume only from an authoritative durable transition.

A stale worker or lost lease cannot dispatch a duplicate role call or persist late output.

## Permission incident

If a role receives or attempts an unauthorised capability:

1. Stop the workflow and revoke the capability.
2. Preserve the original evidence and role audit.
3. Confirm no unauthorised file, Git, GitHub, service, database, or production mutation occurred.
4. Restore affected repository state from the protected baseline if necessary.
5. record the incident and open a defect with a boundary-level regression test.
6. Do not resume until the permission mapping and enforcement test are fixed.

## Rollback

Role orchestration rollback returns routing to the prior worker chain without deleting new durable records.

Rollback sequence:

1. Stop new work intake or drain the worker safely.
2. Capture the exact application SHA, database backup, effective role configuration, and active job inventory.
3. Disable role-based routing through the approved configuration switch.
4. Retain role assignments and audit rows for forward recovery.
5. Restore legacy chain routing only when explicitly configured and validated.
6. Restart through the approved worker drain/restart procedure.
7. Verify worker health, queue ownership, status projection, and zero duplicate jobs.
8. Do not automatically resume jobs whose requirements or plan format cannot be interpreted by the legacy path; hold them for human review.

## Post-change verification

For production or appliance rollout, verify:

- exact deployed commit and artifact equality;
- service active state;
- worker queue and lease health;
- effective role assignments and configuration sources;
- authentication probes without credential leakage;
- no duplicate role calls after restart;
- documentation manifest availability;
- sample read-only scan and role status;
- rollback snapshot integrity.

## Escalation conditions

Stop and request human action when:

- a product decision remains unresolved;
- requirements validation cannot distinguish safe interpretations;
- a role target lacks enforceable permissions;
- model or CLI authentication is ambiguous;
- lifecycle ownership is stale or conflicting;
- deterministic evidence conflicts with model output;
- required documentation cannot be produced safely;
- rollout or rollback postconditions cannot be verified.