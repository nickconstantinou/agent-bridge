# Engineering Worker — User and Operator Guide

## Status

This guide distinguishes the **current worker behaviour** from the **Issue #159 target workflow**. Slice 1 now implements desired role-assignment validation, schema-version-3 persistence, and truthful dormant status. It does not activate role routing or later role lifecycle behaviour.

## Current worker

The current worker turns feature briefs, imported GitHub issues, defect/refactor scans, and approved work items into plans, bounded implementation jobs, draft pull requests, and merge-gated outcomes.

Current owners remain:

- `src/workerBot.ts` and `src/workCallbacks.ts` for Telegram work-item, approval, and status surfaces;
- `src/jobExecutor.ts` and `src/jobExecutorLoop.ts` for durable job execution;
- current handlers under `src/handlers/`;
- `src/workerCliPolicy.ts` and `src/workerDispatch.ts` for effective worker CLI policy;
- `src/workspace.ts` for disposable implementation workspaces;
- current GitHub/PR lifecycle helpers and `src/prMergeGate.ts` for issue, PR, and human merge authority.

The prompt foundation strengthens current planning/TDD contracts. Slice 1 adds desired role persistence but does not switch existing jobs to Technical Lead, Code Worker, or Documentation Steward routing.

## Current dormant role assignments

Operators may configure one desired assignment for each public role using:

- `WORKER_ROLE_ASSIGNMENTS_JSON`;
- optional `WORKER_ROLE_ASSIGNMENT_SCOPE`.

The exact JSON contract is documented in `docs/configuration/agent-role-assignment.md`. Configuration must contain explicit bounded CLI/model targets and cannot contain credentials, prompts, or repository content.

A valid configuration is versioned in SQLite and reported as:

```text
Role assignments: configured_dormant
Role routing: disabled
```

This is desired state only. It does not change which CLI handles a message or job.

### `/chain` output

With no desired role revision, `/chain` keeps its previous legacy-only response.

With a desired revision, `/chain` additionally shows:

- desired revision and configuration source;
- desired primary and fallback targets for each role;
- `Role routing: disabled`;
- effective legacy interactive chain;
- effective legacy code chain;
- effective legacy scribe chain.

The effective legacy chains remain authoritative. Desired role assignments are never labelled effective in Slice 1.

### Database compatibility

Slice 1 advances the worker database schema from version 2 to version 3. Production services do not migrate automatically. A production database must be upgraded through the guarded rollout helper before starting a schema-3 service. See `docs/operations/agentic-worker-runbook.md`.

Removing the JSON configuration stops new desired revisions from being written; it does not delete existing revision history and is not an active-routing rollback because routing is already disabled.

## Target three-role workflow — later slices

Issue #159 defines exactly three configurable roles:

| Role | Target responsibility |
|---|---|
| Technical Lead | Requirements and issue validation, bundle review, planning, bounded guidance, implementation/operations review, final exact-head review, and PR-readiness advice using read-only evidence |
| Code Worker | Read-only scanning/investigation and approved red, green, repair, and verification work in disposable workspaces |
| Documentation Steward | Documentation impact, documentation-only authoring, and validation of every required canonical document |

Scanner is a Code Worker mode. Review and operations are Technical Lead modes, not separate roles.

The later target runtime order is:

```text
request, imported issue, or scan candidate
→ requirements discovery or validation
→ canonical issue
→ requirements_ready
→ Technical Lead implementation plan and red-test contract
→ approval when required
→ Code Worker red/green/repair
→ deterministic verification
→ Technical Lead implementation review
→ Technical Lead operations review when triggered
→ Documentation Steward authoring and validation
→ Technical Lead PR readiness
→ exact-head CI
→ fresh exact-head Technical Lead final review
→ human merge gate
```

A code-changing repair after verification invalidates verification, review, operations, documentation, readiness, CI, and final-review evidence for the previous head. The workflow returns to deterministic verification.

## Multi-issue requests — later slices

When one request is split into multiple child issues, Agent Bridge first assembles all proposed issue bodies without mutating GitHub. The Technical Lead then runs a bundle-wide decomposition review that records implementation delivery order, runtime phase order, one canonical invariant matrix, owners/callers, lifecycle/permission/persistence/GitHub/Platform authority, overlap, dependencies, and unresolved product decisions.

Agent Bridge creates or updates issues only after `ready_for_issue_mutation`.

## Requirements and issue quality — later slices

A detailed issue may pass without additional questions, but it never bypasses validation. A scan finding remains a candidate until the Technical Lead validates, rejects, combines, splits, or requests evidence.

Canonical feature, defect, and refactor contracts are defined in `docs/agentic-maintenance.md`.

## Implementation plans

The Technical Lead target contract owns implementation and test strategy. Generic instructions such as `write tests`, `add unit tests`, or `increase coverage` are invalid.

Each plan includes stable acceptance IDs, product/architecture intent, current owners/callers, classified target paths, comprehensive red-test specifications, bounded work packets, exact verification, documentation obligations, operations/migration/rollback, human gates, and a compact execution contract.

Every target is classified as `existing_at_base`, `existing_in_dependency`, `proposed_new_production`, or `proposed_new_test`. Invalid or unclassified paths block new-plan persistence and approval.

## Red and green execution

The Code Worker receives the approved red-test and execution contract. It does not invent or weaken the strategy.

- Red mode may implement approved failing tests only.
- The focused test must fail for the intended missing behaviour, not syntax, imports, fixtures, timeouts, or unrelated failures.
- Green mode implements the smallest production change and may not modify committed red tests.
- Repair remains inside the approved packet.
- Verify runs approved commands and returns evidence without expanding scope.

Existing TDD Git guards, workspace isolation, queue/lease ownership, provider fallback, and human merge gate remain authoritative.

## Prompt and lifecycle-skill contracts

Canonical prompts are separate by role, mode, and repair purpose. Agent Bridge selects the prompt and separately enforces role, tools, permissions, schemas, validators, budgets, lifecycle state, GitHub mutation, and human gates.

Reusable engineering know-how remains authoritative in four repository skills:

- `requirements-to-acceptance`;
- `risk-based-test-strategy`;
- `red-green-refactor-tdd`;
- `release-readiness-review`.

Each consuming prompt declares its ordered skill set. Prompts and skills resolve only from reviewed source files. Schema migration 2 retires the legacy prompt table; schema migration 3 adds dormant role assignments without changing prompt resolution.

## Exact-head evidence

Verification, implementation review, operations review, documentation validation, PR readiness, CI, and final Technical Lead review evidence identify one `subject_head_sha`.

Required gate status is one of `passed`, `failed`, `not_run`, `not_scheduled`, `stale`, or `unknown`. Only authoritative `passed` evidence for the exact current head satisfies a required gate.

Review independence comes from role and authority separation. A fresh exact-head review by the read-only Technical Lead advisor is independent from Code Worker implementation when the Technical Lead did not author or modify the reviewed implementation and has no mutation authority in the review invocation. The same frontier model or CLI may be reused. Model diversity is recorded separately and is not a blocking requirement. The Code Worker cannot review its own mutation.

## Documentation readiness

`agentic-maintenance.yaml` lists canonical documents and deterministic change triggers. A missing, stale, contradictory, or materially misleading required document blocks readiness and must be corrected and revalidated in the same delivery. A later issue or follow-up does not satisfy readiness.

## Human authority

Nothing merges, deploys, restarts services, changes secrets or permissions, performs destructive operations, or waives policy without the existing explicit human gate.

Models cannot grant themselves tools, mutate GitHub, change role, broaden scope, approve their own work, merge, deploy, or reinterpret missing evidence.

## Current commands

Common current surfaces include:

- `/review [repo]` for a defect scan;
- `/feature <brief>` for feature planning intake;
- `/issues` and `/issue <id>` for work items;
- `/jobs` and `/job <id>` for job state;
- `/approvals` for pending decisions and merge controls;
- `/chain` for effective legacy chains and, when configured, dormant desired role status;
- existing interactive `/cli`, `/models`, and `/effort` surfaces where configured.

Role-native lifecycle commands, capability probes, and active desired/effective reconciliation remain later-slice work.

## Troubleshooting

### Role configuration is rejected

Validate exact role IDs, duplicate/missing roles, target format, fallback count, and unknown/forbidden fields. Do not place tokens, API keys, prompts, or repository content in the JSON.

### Database migration is required

Do not start the production worker against schema version 2 and do not bypass `openProductionDb()`. Use the approved guarded rollout helper with the complete configured database inventory, backups, validation, and rollback evidence.

### `/chain` shows `configured_dormant`

This is expected. Confirm `Role routing: disabled` and verify the effective legacy chains match operator configuration.

### A proposed issue bundle is blocked

Inspect the decomposition-review invariant matrix and resolve conflicts before issue mutation.

### A plan is rejected

Inspect typed validation errors. New plans require structured target provenance, comprehensive red tests, real caller coverage, authoritative oracles, and complete risk matrices.

### Lifecycle skill loading fails

Confirm the declared skill exists, its `skill.json` name/version matches the registry, and `SKILL.md` contains exactly one non-empty runtime-guidance block within budget. Do not paste emergency lifecycle text into prompts.

### Prompt migration finds an unexpected row

Do not restart or bypass migration 2. It preserves schema version 1 and table contents for guarded investigation.

### Documentation blocks readiness

Correct every required stale, contradictory, missing, or misleading document through the documentation-only lane. Do not create a follow-up issue as a substitute.

### Review independence is unavailable

Confirm the final reviewer is the read-only Technical Lead, did not author or modify the implementation, has no mutation authority, and is reviewing the exact checked head in a fresh invocation. A second model or CLI is not required. If those role/authority conditions cannot be met, the workflow remains blocked.

## Canonical references

- Current architecture: `docs/architecture/01-current-architecture.md`
- Engineering Worker architecture: `docs/architecture/engineering-worker.md`
- Role orchestration: `docs/architecture/agentic-worker-orchestration.md`
- Prompt contracts: `docs/architecture/agentic-prompt-contracts.md`
- Maintenance workflow: `docs/agentic-maintenance.md`
- Configuration: `docs/configuration/agent-role-assignment.md`
- Operations: `docs/operations/agentic-worker-runbook.md`
- Testing: `docs/testing/agentic-worker-verification.md`
- Production readiness: `docs/architecture/10-production-readiness.md`
- Decision: `docs/adr/ADR-005-role-based-agentic-orchestration.md`
- Epic plan: `docs/implementation-plans/issue-159-role-based-orchestration.md`
- Prompt/red-test addendum: `docs/implementation-plans/issue-159-prompt-and-red-test-contract.md`
- Execution/readiness addendum: `docs/implementation-plans/issue-159-execution-readiness-safeguards.md`
- Document registry: `agentic-maintenance.yaml`
