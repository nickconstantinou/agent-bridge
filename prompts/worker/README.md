# Worker Prompt Pack

This directory contains the version-controlled default prompts for the Agent Bridge engineering worker.

This is a scaffold only. The current worker handlers still use their existing inline prompts and DB override paths until the follow-up wiring work is completed.

## Boundary

Prompts may guide CLI behavior, but they are not the source of truth for safety. These invariants must remain mechanically enforced in code:

- No live checkout mutation.
- No merge without explicit approval.
- Red tests must fail before implementation.
- Red commits may only contain test files.
- Green commits may not modify test files.
- Test-only imports must not leak into production code.
- PR merge approval must verify the expected head SHA and green CI.
- Repair attempts, PR caps, and stale handling remain code-controlled.

## Prompt precedence after wiring

The intended follow-up implementation should use this precedence:

1. DB override template, if present.
2. Bundled prompt file from this directory.
3. Hardcoded emergency fallback only for critical paths.

## Prompt families

| Prompt key | File | Purpose |
|---|---|---|
| `feature_plan` | `feature-plan.md` | Plan a user-requested feature before work-item approval. |
| `implementation_plan:create` | `implementation-plan-create.md` | Produce the canonical approval/execution plan for a work item. |
| `implementation_plan:improve` | `implementation-plan-improve.md` | Repair a weak implementation plan. |
| `defect_scan:scan` | `defect-scan.md` | Read-only defect discovery. |
| `defect_scan:plan` | `defect-plan.md` | TDD plan for a defect finding. |
| `defect_scan:triage` | `defect-triage.md` | Conservative approve/reject gate for scan findings. |
| `refactor_scan:scan` | `refactor-scan.md` | Read-only refactor opportunity discovery. |
| `refactor_scan:plan` | `refactor-plan.md` | Safe refactor implementation plan. |
| `tdd_implementation:red_test` | `tdd-red-test.md` | Failing-test-only pass. |
| `tdd_implementation:green_implementation` | `tdd-green-implementation.md` | Minimal production implementation pass. |
| `tdd_implementation:ci_fix` | `tdd-ci-fix.md` | Existing PR branch CI repair pass. |
| `tdd_implementation:repair` | `tdd-repair.md` | Repair a failed autonomous attempt. |
| `orchestrated_task:plan` | `orchestrated-plan.md` | Legacy orchestrated task planning prompt. |
| `orchestrated_task:execute` | `orchestrated-execute.md` | Legacy orchestrated task execution prompt. |

## Skill supplements

The files under `supplements/` are compact local adaptations inspired by `addyosmani/agent-skills`. They are intentionally distilled rather than copied wholesale so the worker can inject phase-specific guidance without bloating every prompt.

The follow-up wiring should keep supplements small, deterministic, and specific to each worker phase.