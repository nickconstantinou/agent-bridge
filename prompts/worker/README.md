# Worker Prompt Pack

This directory contains the version-controlled default prompts for the Agent Bridge engineering worker.

This is a scaffold only. The current worker handlers still use their existing inline prompts and DB override paths until the follow-up wiring work is completed.

For the exact handler-by-handler wiring contract, see [`WIRING.md`](./WIRING.md).

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

DB overrides are assumed to be complete templates. The prompt loader should not append bundled supplements to DB overrides unless a caller explicitly opts in.

## Token budget policy

The prompt pack should preserve quality without appending all context to every CLI call.

Wiring rules:

- Inject only the supplements mapped to the current prompt key.
- Keep supplements compact and phase-specific.
- Do not paste full Agent Skills documents into runtime prompts.
- Create a compact execution contract during implementation planning and pass that to red/green/repair phases instead of repeatedly passing the full plan.
- Cap large variables before rendering, especially `body`, `plan_text`, `failure_output`, CI logs, and PR diff excerpts.
- Prefer narrow excerpts for execution phases: relevant phase, target files, verification command, risk boundary, and out-of-scope list.
- Keep the full human-readable plan for approval packs and PR context, not for every CLI execution pass.
- Add prompt-size tests or snapshot checks when wiring handlers.

Recommended context shape:

| Phase | Context to pass |
|---|---|
| Feature, defect, refactor scan | Repository name plus concise scan instructions; let the CLI inspect the repo locally. |
| Implementation planning | Full work item context, capped, plus compact supplements. |
| Red test | Execution contract plus relevant plan slice only. |
| Green implementation | Execution contract, failing-test summary, target files, and verification command. |
| CI fix | Execution contract plus capped CI failure excerpt. |
| Repair | Execution contract plus capped prior failure and current phase. |

## Execution contract

Implementation planning prompts should emit a compact machine-facing section that later phases can consume without the full plan:

```json
{
  "target_files": ["src/example.ts"],
  "test_files": ["src/example.test.ts"],
  "phase": "red-test | green-implementation | ci-fix | repair",
  "verification": "npm test -- example",
  "risk_level": "low | medium | high",
  "out_of_scope": ["unrelated cleanup", "schema migration"]
}
```

The follow-up wiring should store the full Markdown plan for humans and extract/store this compact execution contract for execution prompts.

## Prompt families

| Prompt key | File | Purpose |
|---|---|---|
| `feature_plan` | `feature-plan.md` | Plan a user-requested feature before work-item approval. |
| `implementation_plan:create` | `implementation-plan-create.md` | Produce the canonical approval/execution plan for a work item. |
| `implementation_plan:improve` | `implementation-plan-improve.md` | Repair a weak implementation plan. |
| `implementation_plan:contract_repair` | `implementation-plan-contract-repair.md` | Recover a missing machine contract from an otherwise valid plan. |
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
