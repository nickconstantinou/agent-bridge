---
name: release-readiness-review
description: Use before merging or releasing software changes to check scope, migrations, feature flags, rollback paths, documentation, monitoring, and operational readiness.
---

# Release Readiness Review

Use this skill for pre-merge, pre-release, or deployment-readiness checks.

<!-- BEGIN AGENT_BRIDGE_RUNTIME_GUIDANCE -->
## Review Areas

- Scope: confirm the change matches the stated goal and has no unrelated churn.
- Data: check migrations, backfills, irreversible writes, and compatibility.
- Flags: confirm rollout, kill switch, or config behavior when relevant.
- Rollback: describe how to revert safely and what state may remain.
- Observability: verify logs, metrics, alerts, and dashboards for risky paths.
- Documentation: every required document must describe the final verified behaviour. Missing, stale, contradictory, or misleading required documentation is a blocker and must be corrected in the same delivery rather than deferred.
- Evidence: distinguish `passed`, `failed`, `not_run`, `not_scheduled`, `stale`, and `unknown`; only authoritative passed evidence for the exact current head satisfies a required gate.
- Validation: name post-release checks and expected signals.

## Output

Lead with blocking risks. Then list non-blocking observations and final release confidence. Do not classify stale required documentation or missing exact-head evidence as a non-blocking follow-up.
<!-- END AGENT_BRIDGE_RUNTIME_GUIDANCE -->
