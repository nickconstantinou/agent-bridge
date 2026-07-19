# Worker Prompt Wiring Guide

This guide records the current prompt boundaries and the Issue #159 migration path.

## Current state

The repository has two prompt registries:

- `src/workerPrompts.ts` — active legacy handler prompts, including existing database override compatibility;
- `src/agenticPromptContracts.ts` — canonical source-controlled role/mode prompts for Technical Lead, Code Worker, and Documentation Steward.

The canonical registry and prompt files are implemented in PR #160. Full role dispatch is delivered by later Issue #159 slices. Do not create a second loader, prompt service, validator, or workflow engine.

## Core rules

- Canonical role prompts resolve from source-controlled files only.
- Canonical contracts declare required variables; missing input fails closed.
- Context is bounded before rendering.
- Stable template identity and invocation-specific rendered identity are recorded separately.
- Database prompt text is never a fallback or override for a canonical role prompt.
- Existing database overrides remain temporary compatibility inputs only for unmigrated legacy handlers.
- Prompt text never owns tools, permissions, budgets, schemas, validators, lifecycle, approvals, merge, or deployment authority.
- Fallback models use the same prompt key, version, source template, output contract, validator, tools, and permission profile.
- Full planning, red-test repair, and execution-contract repair use separate prompt keys.

## Canonical registry

`src/agenticPromptContracts.ts` owns:

- stable prompt key;
- contract version;
- owning role and mode;
- source file path;
- output-contract identifier;
- required render variables;
- compatibility aliases;
- the prohibition on database override.

Canonical files live under `prompts/worker/roles/`.

### Technical Lead

| Key | Mode | Required variables |
|---|---|---|
| `technical_lead:requirements` | requirements | `repository`, `request`, `source_context`, `evidence_catalog`, `known_decisions` |
| `technical_lead:issue_validation` | issue validation | `change_type`, `candidate_issue`, `evidence_catalog`, `decisions` |
| `technical_lead:issue_authoring` | issue authoring | `change_type`, `validated_requirements`, `evidence_catalog`, `decisions` |
| `technical_lead:planning` | planning | `canonical_issue`, `repository_evidence`, `documentation_impact`, `constraints` |
| `technical_lead:planning_repair:red_tests` | focused repair | `validation_errors`, `canonical_issue`, `original_plan`, `repository_evidence` |
| `technical_lead:planning_repair:execution_contract` | focused repair | `validation_errors`, `original_plan` |
| `technical_lead:executor_guidance` | guidance | `canonical_issue`, `approved_plan`, `blocked_evidence`, `repository_evidence` |
| `technical_lead:implementation_review` | review | `canonical_issue`, `approved_plan`, `implementation_evidence`, `verification_evidence`, `documentation_evidence` |
| `technical_lead:operations_review` | operations | `issue_and_plan`, `implementation_evidence`, `operations_evidence` |
| `technical_lead:pr_readiness` | readiness | `issue_and_plan`, `implementation_review`, `operations_review`, `documentation_validation`, `verification_evidence`, `pr_evidence` |

### Code Worker

| Key | Mode | Required variables |
|---|---|---|
| `code_worker:scan:defect` | scan | `repository`, `scan_scope`, `repository_evidence` |
| `code_worker:scan:refactor` | scan | `repository`, `scan_scope`, `repository_evidence` |
| `code_worker:investigate` | investigate | `target`, `questions`, `repository_evidence` |
| `code_worker:red` | red | `canonical_issue`, `approved_packet`, `repository_state` |
| `code_worker:green` | green | `canonical_issue`, `approved_packet`, `red_evidence` |
| `code_worker:repair` | repair | `approved_packet`, `repair_evidence`, `repository_state` |
| `code_worker:verify` | verify | `verification_contract`, `repository_state` |

### Documentation Steward

| Key | Mode | Required variables |
|---|---|---|
| `documentation_steward:impact` | impact | `issue_and_plan`, `documentation_manifest`, `change_evidence` |
| `documentation_steward:author` | author | `documentation_impact`, `implementation_context`, `path_policy` |
| `documentation_steward:validate` | validate | `documentation_impact`, `implementation_evidence`, `documents` |
| `documentation_steward:maintenance` | maintenance | `documentation_manifest`, `documentation_inventory`, `implementation_evidence` |

## Advisor planning and red tests

`technical_lead:planning` produces the full plan once. It must emit:

- approved acceptance criteria with stable IDs;
- concrete target files and ownership boundaries;
- architectural intent;
- a risk-based Test Plan;
- structured `Red Tests` records;
- `Red Test Coverage` matrices;
- bounded implementation phases;
- documentation and operations obligations;
- a compact Execution Contract;
- exact verification and escalation guidance.

The active legacy `implementation_plan:create` and `implementation_plan:improve` prompts now emit the same Red Tests and Red Test Coverage structures. `validateImplementationPlan(...)` rejects missing sections, missing required red-test fields, and missing coverage matrices.

Focused repair remains bounded:

1. Generate or improve the full plan.
2. Validate the whole plan.
3. When only red tests/coverage are invalid, later role wiring may invoke `technical_lead:planning_repair:red_tests` once.
4. When only the execution contract is missing/invalid, use the separate execution-contract repair.
5. Merge only the repaired section.
6. Revalidate the complete plan.
7. Fail closed after the bounded repair.

A repair prompt cannot change requirements, scope, non-goals, architecture, packet boundaries, permissions, operations policy, or human gates.

## Legacy handler wiring

Existing handlers continue through `loadWorkerPrompt(...)` until their role phase migrates:

| Handler | Legacy key | Database compatibility |
|---|---|---|
| `featurePlan.ts` | `feature_plan` | existing rows temporarily readable |
| `implementationPlan.ts` | `implementation_plan:create`, `implementation_plan:improve`, `implementation_plan:contract_repair` | existing rows temporarily readable |
| `defectScan.ts` | `defect_scan:*` | existing rows temporarily readable |
| `refactorScan.ts` | `refactor_scan:*` | existing rows temporarily readable |
| `tddImplementation.ts` | `tdd_implementation:*` | existing rows temporarily readable |
| `orchestratedTask.ts` | `orchestrated_task:*` | existing rows temporarily readable |

Legacy override precedence remains unchanged only for those existing callers. It must not be copied into canonical role dispatch.

## Database override retirement

The `prompts` table is mutable configuration, not backup. Git history and released prompt files provide reproducible fallback and rollback.

Retirement sequence:

1. inventory keys and non-empty row counts per workspace without logging prompt text;
2. classify each retained row as migrate, intentionally discard, or hold;
3. move approved custom behaviour into reviewed prompt files and tests;
4. switch each handler to its canonical role prompt;
5. disable the corresponding database read;
6. prove callers and retained rows are zero;
7. remove write APIs, then read APIs;
8. drop the table in a separately approved, backup/restore-qualified migration.

Do not drop the table in PR #160: existing rows are not yet inventoried and current handlers still call `getPrompt()`.

## Execution context

Do not pass the full human plan to every execution phase. Persist the validated plan and extract bounded packets containing:

- linked acceptance criteria and `RedTestSpec` IDs;
- permitted files or ownership boundary;
- exact red and verification commands;
- expected evidence;
- non-goals and escalation conditions;
- applicable documentation and operations facts.

The Code Worker executes the approved test strategy. It does not invent or weaken it.

## Required tests

Before a role phase becomes authoritative, prove:

- exact prompt key/version and source file;
- declared required variables match template placeholders;
- missing inputs fail closed;
- context is bounded;
- template hash is stable across job context while rendered hash changes appropriately;
- canonical loading ignores conflicting database rows;
- fallback models preserve the prompt contract;
- sibling prompt files and hashes remain unchanged;
- comprehensive red-test and coverage validation fails closed;
- legacy behaviour remains unchanged while its role phase is disabled;
- no prompt path changes tools, permissions, lifecycle, approvals, or audit authority.

## Fail-safe behaviour

If prompt loading, required-input validation, plan validation, contract extraction, context budgeting, or output validation fails, Agent Bridge does not guess. Required work fails closed or enters the explicit human-needed state defined by the owning workflow.
