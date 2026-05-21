---
name: release-readiness-review
description: Use before merging or releasing software changes to check scope, migrations, feature flags, rollback paths, documentation, monitoring, and operational readiness.
---

# Release Readiness Review

Use this skill for pre-merge, pre-release, or deployment-readiness checks.

## Review Areas

- Scope: confirm the change matches the stated goal and has no unrelated churn.
- Data: check migrations, backfills, irreversible writes, and compatibility.
- Flags: confirm rollout, kill switch, or config behavior when relevant.
- Rollback: describe how to revert safely and what state may remain.
- Observability: verify logs, metrics, alerts, and dashboards for risky paths.
- Documentation: update user, operator, API, or changelog docs when needed.
- Validation: name post-release checks and expected signals.

## Output

Lead with blocking risks. Then list non-blocking follow-ups and final release confidence.
