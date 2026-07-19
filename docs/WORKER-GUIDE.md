# Engineering Worker — User and Operator Guide

## Status

This guide distinguishes the **current worker behaviour** from the **Issue #159 target workflow**. PR #160 supplies prompt, lifecycle-skill, plan-validation, documentation-policy, and schema foundations; it does not activate role assignment or role-based routing.

## Current worker

The current worker turns feature briefs, imported GitHub issues, defect/refactor scans, and approved work items into plans, bounded implementation jobs, draft pull requests, and merge-gated outcomes.

Current owners remain:

- `src/workerBot.ts` and `src/workCallbacks.ts` for Telegram work-item and approval surfaces;
- `src/jobExecutor.ts` and `src/jobExecutorLoop.ts` for durable job execution;
- current handlers under `src/handlers/`;
- `src/workerCliPolicy.ts` and `src/workerDispatch.ts` for effective worker CLI policy;
- `src/workspace.ts` for disposable implementation workspaces;
- current GitHub/PR lifecycle helpers and `src/prMergeGate.ts` for issue, PR, and human merge authority.

PR #160 strengthens the active implementation-plan and TDD prompt path but does not switch existing jobs to Technical Lead, Code Worker, or Documentation Steward routing.

## Target three-role workflow

Issue #159 introduces exactly three configurable roles:

| Role | Target responsibility |
|---|---|
| Technical Lead | Requirements and issue validation, bundle review, planning, bounded guidance, implementation/operations review, and PR-readiness advice using read-only evidence |
| Code Worker | Read-only scanning/investigation and approved red, green, repair, and verification work in disposable workspaces |
| Documentation Steward | Documentation impact, documentation-only authoring, and validation of every required canonical document |

Scanner is a Code Worker mode. Review and operations are Technical Lead modes, not separate roles.

The target runtime order is:

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
→ human merge gate
```

A code-changing repair after verification invalidates verification, review, operations, documentation, and readiness evidence for the previous head. The workflow returns to deterministic verification.

## Multi-issue requests

When one request is split into multiple child issues, Agent Bridge first assembles all proposed issue bodies without mutating GitHub. The Technical Lead then runs a bundle-wide decomposition review that records:

- implementation delivery order;
- runtime phase order;
- one canonical invariant matrix;
- current owners and caller paths;
- lifecycle, permission, persistence, GitHub, and platform/appliance authority;
- overlap, missing dependencies, and unresolved product decisions.

Agent Bridge creates or updates issues only after `ready_for_issue_mutation`. A group of individually plausible issues is not accepted when the bundle contradicts itself.

## Requirements and issue quality

A detailed issue may pass without additional questions, but it never bypasses validation. A scan finding remains a candidate until the Technical Lead validates, rejects, combines, splits, or requests evidence.

Canonical feature, defect, and refactor contracts are defined in `docs/agentic-maintenance.md`.

## Implementation plans

The Technical Lead owns the implementation and test strategy. Generic instructions such as `write tests`, `add unit tests`, or `increase coverage` are invalid.

Each plan includes:

- stable acceptance-criterion IDs;
- product and architecture intent;
- current owners and real caller paths;
- structured target-path provenance;
- comprehensive red-test specifications;
- acceptance, architecture, invariant, and triggered-risk coverage;
- bounded red/green/repair/verify packets;
- exact verification commands;
- documentation obligations;
- operations, migration, rollback, and human gates;
- a compact execution contract.

Every production and test path is classified as:

- `existing_at_base`;
- `existing_in_dependency`;
- `proposed_new_production`;
- `proposed_new_test`.

Dependency paths name the dependency PR and exact reviewed ref. Proposed production files name the neighbouring current owner and why no existing file is sufficient. Invalid or unclassified paths block new-plan persistence and approval.

Already-persisted plans created before this provenance contract retain a narrow compatibility check for concrete paths. New and repaired model output must use the structured contract.

## Red and green execution

The Code Worker receives the approved red-test and execution contract. It does not invent or weaken the strategy.

- Red mode may implement the approved failing tests only.
- The focused test must fail for the expected missing behaviour, not syntax, imports, fixtures, timeouts, or unrelated failures.
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

Each consuming prompt declares its ordered skill set. `src/lifecycleSkillGuidance.ts` validates each manifest and the single marked runtime-guidance block, enforces budgets, and records skill identities. Provider fallback preserves the same prompt and skill contract.

Prompts and skills resolve only from reviewed source files. Schema migration 2 retires the absent or empty legacy prompt table and rejects unexpected rows without data loss. Prompt rollback is application rollback to a reviewed SHA.

## Exact-head evidence

Verification, implementation review, operations review, documentation validation, PR readiness, and CI evidence identify one `subject_head_sha`.

Required gate status is one of:

- `passed`;
- `failed`;
- `not_run`;
- `not_scheduled`;
- `stale`;
- `unknown`.

Only authoritative `passed` evidence for the exact current head satisfies a required gate. A workflow must not describe `not_scheduled`, `not_run`, or stale evidence as green.

Required review independence and actual review independence are recorded separately. A fresh session using the same model is not independent merely because the context is new.

## Documentation readiness

`agentic-maintenance.yaml` lists canonical documents and deterministic change triggers.

A PR cannot become ready until:

- every triggered required document is current and validated against the exact final head; or
- `no_documentation_change` is validated with rationale, trigger evidence, and Technical Lead confirmation.

A missing, stale, contradictory, or materially misleading required document is a blocking defect. It must be corrected and revalidated in the same delivery. Creating a later issue, assigning an owner, or listing a follow-up does not satisfy readiness.

When a required correction materially changes approved scope or authority, the workflow holds for human scope approval. It does not defer the stale state and claim readiness.

## Human authority

Nothing merges, deploys, restarts services, changes secrets or permissions, performs destructive operations, or waives policy without the existing explicit human gate.

Models cannot grant themselves tools, mutate GitHub, change role, broaden scope, approve their own work, merge, deploy, or reinterpret missing evidence.

## Current commands

Use the existing worker commands and callbacks for current functionality. Commands or status fields described in target-state architecture are not available until their owning Issue #159 slice is implemented and qualified.

Common current surfaces include:

- `/review [repo]` for a read-only defect scan;
- `/feature <brief>` for feature planning intake;
- `/issues` and `/issue <id>` for work items;
- `/jobs` and `/job <id>` for job state;
- `/approvals` for pending decisions and merge controls;
- existing interactive `/cli`, `/models`, `/effort`, and chain/status surfaces where configured.

Consult the live command help and current code for the exact deployed surface. Target role assignment, desired/effective role status, and role-native lifecycle phases remain planned work until delivered by Slices 1–10.

## Troubleshooting

### A proposed issue bundle is blocked

Inspect the decomposition-review invariant matrix. Resolve runtime-order versus implementation-order conflicts, duplicate ownership, missing lifecycle edges, unclassified paths, or unresolved product decisions before issue mutation.

### A plan is rejected

Inspect typed validation errors. New plans require structured target provenance, comprehensive red tests, real caller coverage, authoritative oracles, and complete risk matrices.

### Lifecycle skill loading fails

Confirm the declared skill exists, its `skill.json` name/version matches the registry, and `SKILL.md` contains exactly one non-empty runtime-guidance block within budget. Do not paste emergency lifecycle text into prompts.

### Prompt migration finds an unexpected row

Do not restart or bypass the migration. Migration 2 preserves schema version 1 and the table contents for guarded investigation. Runtime code has no prompt-table reader or writer.

### Documentation blocks readiness

Correct every required stale, contradictory, missing, or misleading document through the documentation-only lane. Do not create a follow-up issue as a substitute for correction.

### Review is non-independent

Role separation may remain intact, but repository risk policy can require a different CLI/model or different model. If the required level is unavailable, the workflow holds for human decision.

## Canonical references

- Current architecture: `docs/architecture/01-current-architecture.md`
- Engineering Worker architecture: `docs/architecture/engineering-worker.md`
- Role orchestration: `docs/architecture/agentic-worker-orchestration.md`
- Prompt contracts: `docs/architecture/agentic-prompt-contracts.md`
- Maintenance workflow: `docs/agentic-maintenance.md`
- Configuration: `docs/configuration/agent-role-assignment.md`
- Operations: `docs/operations/agentic-worker-runbook.md`
- Testing: `docs/testing/agentic-worker-verification.md`
- Decision: `docs/adr/ADR-005-role-based-agentic-orchestration.md`
- Epic plan: `docs/implementation-plans/issue-159-role-based-orchestration.md`
- Prompt/red-test addendum: `docs/implementation-plans/issue-159-prompt-and-red-test-contract.md`
- Document registry: `agentic-maintenance.yaml`
