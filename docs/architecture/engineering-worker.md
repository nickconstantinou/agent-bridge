# Engineering Worker Architecture

## Status

Canonical target-state architecture.

## Purpose

The Engineering Worker is the software-engineering work engine inside Agent Bridge OSS. It converts incomplete intent, imported issues, and repository findings into validated issues, approved plans, tested branches, current documentation, and pull requests while preserving explicit human approval for merges, deployments, policy exceptions, and destructive operations.

It is not a general-purpose autonomous agent framework. Agent Bridge owns orchestration and authority; models operate within bounded roles.

## Role model

The worker exposes exactly three configurable roles:

| Role | Responsibilities | Authority |
|---|---|---|
| Technical Lead | Requirements discovery and validation, canonical issues, implementation plans, task decomposition, bounded guidance, implementation review, operations review, PR readiness | Bounded read-only evidence |
| Code Worker | Defect/refactor scans, investigation, TDD implementation, repair, deterministic verification | Mode-specific read-only or worktree mutation |
| Documentation Steward | Documentation impact, documentation-only authoring, documentation validation and maintenance | Read-only or documentation-path-only mutation |

Scanner is a Code Worker mode. Independent review and operations are Technical Lead modes. These are not separate platform roles.

Full role and workflow architecture: `docs/architecture/agentic-worker-orchestration.md`.

## Core workflow

```text
Raw request, imported issue, or scan finding
→ classify feature | defect | refactor
→ Technical Lead requirements discovery or validation
→ canonical issue
→ requirements_ready
→ Technical Lead implementation plan and execution contract
→ documentation impact
→ approval when policy requires it
→ Code Worker red/green implementation in a disposable workspace
→ deterministic verification
→ Technical Lead implementation and operations review
→ Documentation Steward authoring and validation
→ PR readiness
→ draft PR and CI
→ human merge approval
```

A scan finding is a candidate, not approved work. An apparently complete issue still receives repository-grounded validation. No implementation plan is created before `requirements_ready`.

## Agent Bridge authority

Agent Bridge owns:

- classification and workflow transitions;
- canonical work and phase state;
- leases, cancellation, restart recovery, and stale-owner fencing;
- role assignment and provider/model fallback;
- permission profiles and capability tokens;
- context selection, redaction, freshness, and budgets;
- structured-output validation and bounded repair;
- deterministic tests and evidence;
- workspace and Git policy;
- documentation triggers;
- approvals, GitHub mutation, merge, deployment, and destructive-operation gates;
- audit and status projection.

Models cannot change role, grant themselves tools, expand scope, approve their own output, merge, deploy, or override deterministic or human gates.

## Requirements and issue authority

GitHub or local input is not assumed complete. The Technical Lead gathers repository facts through typed, allowlisted, bounded read-only tools and surfaces unresolved product decisions to a human.

The canonical issue is the durable unit of implementation work. It records current and required behaviour, scope, non-goals, invariants, acceptance criteria and verification, authoritative evidence, documentation and operational impact, security/data impact, compatibility, rollout, and unresolved decisions.

Type-specific contracts are in `docs/agentic-maintenance.md`.

## Planning

The Technical Lead uses the existing authoritative advisor service to create the repository-grounded plan. Planning includes:

- requirement traceability;
- architecture and ownership boundaries;
- bounded Code Worker packets;
- red-green-refactor phases;
- verification evidence;
- documentation obligations;
- operations, migration, rollback, and escalation conditions;
- a validated machine-readable execution contract.

The prior scribe chain may remain only as explicit compatibility fallback. It is not the target source of canonical requirements or plans. Structural validation and bounded repair remain fail-closed before persistence.

## Execution

Code Worker permissions depend on mode:

- `scan` and `investigate`: read-only;
- `red`: test-only mutation and demonstrated expected failure;
- `green`: production mutation without changing committed red tests;
- `repair`: mutation bounded to the approved packet;
- `verify`: approved commands and evidence without new scope.

Implementation work remains in disposable clones/workspaces. Existing supervisor, TDD commit separation, workspace isolation, head-SHA verification, CI checks, and merge gate remain authoritative.

## Documentation

The Documentation Steward assesses impact during planning and updates documents after final implementation evidence exists. Author mode is restricted by `agentic-maintenance.yaml` to documentation paths.

A PR is not ready until required documents are current or a validated `no_documentation_change` decision is recorded.

## Role assignment

A role assignment binds an authenticated CLI, explicit model, fallbacks, permissions, budgets, and output contracts. The platform supports automatic, recommended, and manual selection.

With one authenticated CLI, Agent Bridge selects models independently for each role. With one model, role sessions and permissions remain separate while status reports model diversity and independent-model review as unavailable.

Review preference is different CLI/model, then different model on the same CLI, then a fresh Technical Lead session, then the same target marked non-independent.

Configuration reference: `docs/configuration/agent-role-assignment.md`.

## Invariants

1. Nothing merges without explicit human approval.
2. Destructive operations, production deployment, secret/permission changes, and policy exceptions require explicit human approval.
3. Implementation happens in disposable workspaces, not live checkouts.
4. GitHub is a delivery and external intake surface, not the job-state store.
5. SQLite repositories remain authoritative for work, job, phase, role, audit, and approval state.
6. Incoming issues and scan findings are untrusted requirements inputs until validated.
7. No plan before `requirements_ready`.
8. Technical Lead remains read-only.
9. Code Worker and Documentation Steward permissions are mode-specific and Bridge-enforced.
10. Deterministic evidence wins over model claims.
11. Terminal state cannot be overwritten by late output.
12. Restart, retry, cancellation, or lease loss cannot duplicate logical role calls.
13. Required documentation is a readiness gate.

## Approval model

Routine in-policy operations may create work items, gather read-only evidence, author canonical issues, create plans, create branches, perform TDD, run verification, update approved documentation, push agent branches, and open or refresh draft PRs.

Human approval remains required for unresolved product decisions, merge, destructive Git, force-push, branch deletion outside approved cleanup, service restart, production deploy, secret/config/permission changes, configured-cap exceptions, and policy changes.

## Operational and verification guides

- User and command guide: `docs/WORKER-GUIDE.md`
- Maintenance workflow: `docs/agentic-maintenance.md`
- Role configuration: `docs/configuration/agent-role-assignment.md`
- Operations and recovery: `docs/operations/agentic-worker-runbook.md`
- Testing: `docs/testing/agentic-worker-verification.md`
- ADR: `docs/decisions/ADR-009-role-based-agentic-orchestration.md`
- Machine-readable document registry: `agentic-maintenance.yaml`
- Implementation handoff: `docs/implementation-plans/issue-159-role-based-orchestration.md`