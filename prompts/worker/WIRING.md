# Worker Prompt Wiring Guide

## Status

Worker prompts and lifecycle skills are source-controlled only. The former SQLite override path and loader override API are removed by PR #160.

## Core rules

- Resolve every prompt through `loadWorkerPrompt(...)` or `loadAgenticPrompt(...)` using registered repository files.
- Declare canonical lifecycle know-how through `lifecycleSkills`; do not paste skill content into prompt files.
- Extract runtime guidance only from the single marked block in each canonical `skills/*/SKILL.md`.
- Validate the matching `skill.json` name/version and fail closed on missing, duplicate, malformed, oversized, or version-mismatched guidance.
- Do not add runtime prompt text, database overrides, operator-editable prompt fields, or hardcoded emergency prompt fallbacks.
- Keep full plans for approval/audit surfaces and pass compact execution contracts to red, green, CI-fix, and repair phases.
- Keep permissions, validators, budgets, lifecycle transitions, retries, merge, and deployment controls outside prompt and skill text.
- Missing files, invalid required context, malformed structured output, or failed budget checks fail closed.

## Lifecycle skill composition

`src/lifecycleSkillGuidance.ts` is the only runtime extractor and composer. It owns:

- the four canonical lifecycle skill keys and expected versions;
- guidance block marker validation;
- manifest validation;
- per-skill and composed budgets;
- deterministic ordered composition;
- skill content and skill-set hashes.

`src/agenticPromptContracts.ts` maps every role/mode to its explicit skills and records role-template, skill-set, composed-template, and rendered hashes.

`src/workerPrompts.ts` maps compatibility keys to the same lifecycle skills before appending any additional Agent Bridge-specific supplements. Compatibility prompts must not maintain a second TDD, requirements, risk, or readiness knowledge source.

## Current handler map

| Handler | Prompt key | Primary variables |
|---|---|---|
| `featurePlan.ts` | `feature_plan` | `repository`, `brief` |
| `implementationPlan.ts` | `implementation_plan:create` | `repository`, `kind`, `source`, `title`, `body` |
| `implementationPlan.ts` | `implementation_plan:improve` | `missing`, `planText` |
| `implementationPlan.ts` | `implementation_plan:contract_repair` | `planText` |
| `defectScan.ts` | `defect_scan:scan` / `plan` / `triage` | repository and bounded finding evidence |
| `refactorScan.ts` | `refactor_scan:scan` / `plan` | repository and bounded finding evidence |
| `tddImplementation.ts` | `tdd_implementation:*` | approved execution contract and bounded plan/failure context |
| `orchestratedTask.ts` | `orchestrated_task:plan` / `execute` | issue or compact execution context |

Compatibility keys still map to source-controlled files and canonical lifecycle skills. Role-native routing must preserve the same source-only rule and may not change the skill set during provider fallback.

## Plan wiring

1. Load the create prompt and its declared requirements, risk, and TDD skills.
2. Generate and validate the complete Markdown plan.
3. Require structured `Red Tests`, `Red Test Coverage`, and `Execution Contract` sections.
4. Use full-plan improvement once when multiple sections are invalid.
5. Use a dedicated focused repair prompt only when one section is invalid.
6. Revalidate the complete plan before persistence or approval.

## Execution wiring

- Red mode receives approved red-test records plus risk-based testing and TDD guidance, and may change tests only.
- Green mode receives committed red evidence plus TDD guidance, and may not alter red tests.
- CI-fix and repair receive bounded failure context and remain inside the approved packet.
- Verify and readiness modes consume risk/readiness skills and return evidence without introducing source changes.

## Schema migration 2

The guarded rollout helper upgrades schema version 1 databases to version 2. Migration 2 treats an absent table as retired, drops an empty `prompts` table transactionally, rejects a populated table without logging contents, and leaves `user_version = 1` and the table intact on rejection.

Production services using `openProductionDb()` must not restart on version 1 databases before guarded migration completes.

## Required verification

Run lifecycle-skill extraction/mapping/drift tests, prompt loader/contract tests, handler wiring tests, version 0 and version 1 migration tests, the populated-table rollback test, the full suite, typecheck, Architecture Lint, `git diff --check`, and exact-head GitHub Actions.
