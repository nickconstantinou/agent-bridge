# Worker Prompt Wiring Guide

## Status

Worker prompts are source-controlled only. The former SQLite override path and loader override API are removed by PR #160.

## Core rules

- Resolve every prompt through `loadWorkerPrompt(...)` or `loadAgenticPrompt(...)` using its registered repository file.
- Do not add runtime prompt text, database overrides, operator-editable prompt fields, or hardcoded emergency prompt fallbacks.
- Keep full plans for approval/audit surfaces and pass compact execution contracts to red, green, CI-fix, and repair phases.
- Keep permissions, validators, budgets, lifecycle transitions, retries, merge, and deployment controls outside prompt text.
- Missing files, invalid required context, malformed structured output, or failed budget checks fail closed.

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

Compatibility keys still map to source-controlled files. Role-native routing must preserve the same source-only rule.

## Plan wiring

1. Load the create prompt from its registered file.
2. Generate and validate the complete Markdown plan.
3. Require structured `Red Tests`, `Red Test Coverage`, and `Execution Contract` sections.
4. Use full-plan improvement once when multiple sections are invalid.
5. Use a dedicated focused repair prompt only when one section is invalid.
6. Revalidate the complete plan before persistence or approval.

## Execution wiring

- Red mode receives approved red-test records and may change tests only.
- Green mode receives committed red evidence and may not alter red tests.
- CI-fix and repair receive bounded failure context and remain inside the approved packet.
- Verify mode returns evidence without introducing source changes.

## Schema migration 2

The guarded rollout helper upgrades schema version 1 databases to version 2. Migration 2 treats an absent table as retired, drops an empty `prompts` table transactionally, rejects a populated table without logging contents, and leaves `user_version = 1` and the table intact on rejection.

Production services using `openProductionDb()` must not restart on version 1 databases before guarded migration completes.

## Required verification

Run prompt loader/contract tests, handler wiring tests, version 0 and version 1 migration tests, the populated-table rollback test, the full suite, typecheck, Architecture Lint, `git diff --check`, and exact-head GitHub Actions.
