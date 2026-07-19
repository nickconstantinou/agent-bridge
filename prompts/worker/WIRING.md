# Worker Prompt Pack Wiring Guide

This guide is for the follow-up coding agent that wires the scaffolded prompt pack into runtime handlers.

The scaffold PR intentionally does not change runtime behavior. Wiring must be done in a later PR with tests.

## Core rules

- Preserve DB override precedence.
- Treat DB override templates as complete by default; do not append bundled supplements unless explicitly requested.
- Use bundled prompt files only when DB override is absent.
- Use compact execution contracts for execution phases.
- Keep full Markdown plans for humans: approval packs, issue comments, and PR context.
- Keep safety-critical behavior enforced in code.
- Use truncation only as a safety cap after structured context extraction.

## Existing storage shape

`work_item_plans` already stores:

- `plan_text`: full human-readable Markdown plan
- `quality_json`: JSON metadata

Prefer storing the parsed execution contract inside `quality_json` to avoid a schema migration in the first wiring PR:

```json
{
  "valid": true,
  "missing": [],
  "execution_contract": {
    "target_files": [],
    "test_files": [],
    "phase_order": [],
    "red_test_command": "",
    "verification_command": "",
    "risk_level": "low",
    "human_decision_required": false,
    "out_of_scope": [],
    "notes_for_red_pass": "",
    "notes_for_green_pass": ""
  }
}
```

A later schema migration can split this into a dedicated column if needed, but it is not required for the first wiring pass.

## Recommended helper functions

Add pure helpers before handler wiring:

```ts
extractExecutionContract(planText: string): ExecutionContractResult
buildExecutionPromptContext(input: {
  planText: string;
  executionContract: WorkerExecutionContract;
  phase: "red" | "green" | "ci_fix" | "repair";
}): { execution_contract: string; plan_text: string }
```

`extractExecutionContract` should:

- find the `## Execution Contract` section
- extract the first JSON fenced block inside it, or the first valid JSON object after the heading
- validate required fields and types
- reject missing or invalid contracts with a structured error

Do not silently fall back to the full plan when contract extraction fails.

## Handler wiring map

| Handler | Prompt key | DB key | Primary variables |
|---|---|---|---|
| `featurePlan.ts` | `feature_plan` | `feature_plan` | `repository`, `brief` |
| `implementationPlan.ts` | `implementation_plan:create` | `implementation_plan:create` | `repository`, `kind`, `source`, `title`, `body` |
| `implementationPlan.ts` | `implementation_plan:improve` | `implementation_plan:improve` | `missing`, `planText` |
| `implementationPlan.ts` | `implementation_plan:contract_repair` | `implementation_plan:contract_repair` | `planText` |
| `defectScan.ts` | `defect_scan:scan` | `defect_scan:scan` | `repository`, optional `pr_changed_files`, optional `typecheck_output` |
| `defectScan.ts` | `defect_scan:plan` | `defect_scan:plan` | `repository`, `title`, `evidence`, `impact`, `impact_score`, `effort_score` |
| `defectScan.ts` | `defect_scan:triage` | `defect_scan:triage` | `repository`, `findings` |
| `refactorScan.ts` | `refactor_scan:scan` | `refactor_scan:scan` | `repository` |
| `refactorScan.ts` | `refactor_scan:plan` | `refactor_scan:plan` | `repository`, `title`, `rationale`, `files`, `impact_score`, `effort_score` |
| `tddImplementation.ts` | `tdd_implementation:red_test` | `tdd_implementation:red_test` | `work_item_id`, `title`, `execution_contract`, capped `plan_text` |
| `tddImplementation.ts` | `tdd_implementation:green_implementation` | `tdd_implementation:green_implementation` | `work_item_id`, `title`, `execution_contract`, capped `plan_text` |
| `tddImplementation.ts` | `tdd_implementation:ci_fix` | `tdd_implementation:ci_fix` | `title`, `execution_contract`, capped `plan_text`, capped `failure_output` |
| `tddImplementation.ts` | `tdd_implementation:repair` | `tdd_implementation:repair` | `title`, `execution_contract`, capped `plan_text`, capped `failure_output` |
| `orchestratedTask.ts` | `orchestrated_task:plan` | `orchestrated_task:plan` | `repository`, `title`, `body` |
| `orchestratedTask.ts` | `orchestrated_task:execute` | `orchestrated_task:execute` | `title`, `execution_contract`, capped `plan_text` |

## Implementation-plan wiring

1. Load `implementation_plan:create` through `loadWorkerPrompt(...)`.
2. Run the CLI.
3. Validate the Markdown plan with existing `validateImplementationPlan(...)`.
4. Extract `## Execution Contract`.
5. If quality validation or contract extraction fails, run `implementation_plan:improve`.
6. Validate and extract again.
7. If the replacement plan is otherwise valid but still omits the contract, run one focused `implementation_plan:contract_repair` pass and append only a validated contract section.
8. If still invalid, fail safe: mark the job failed or require human review.
9. Store full Markdown in `plan_text`.
10. Store quality plus `execution_contract` in `quality_json`.

## TDD wiring

Before red/green/CI-fix/repair prompts:

1. Load the stored plan.
2. Read `execution_contract` from `quality_json`.
3. If missing or invalid, enqueue/trigger implementation-plan improvement before running code.
4. Build phase-specific context:
   - `execution_contract`: compact JSON string
   - `plan_text`: short relevant excerpt only
   - `failure_output`: capped focused failure excerpt for CI/repair
5. Call `loadWorkerPrompt(...)` with those variables.

Never pass the full implementation plan to red/green/CI-fix/repair by default.

## CI and repair context extraction

Prefer this order:

1. failing command
2. failing test name or workflow step
3. error block or stack frame
4. relevant file path
5. tail of log as fallback

Avoid passing full workflow logs unless explicitly requested by a future operator setting.

## Tests to add before or with wiring

Prompt loader tests:

- renders placeholders
- leaves missing placeholders visible or fails explicitly, depending on chosen policy
- uses DB template over bundled file
- does not append supplements to DB templates by default
- can opt in to supplement append for DB templates
- caps large variables
- caps supplement text

Execution contract tests:

- extracts fenced JSON from `## Execution Contract`
- extracts unfenced JSON object from the section
- rejects missing contract
- rejects invalid JSON
- rejects wrong field types
- preserves target files and verification commands

Handler wiring tests:

- implementation plan stores `execution_contract` in `quality_json`
- invalid contract triggers improve path or safe failure
- red prompt receives execution contract and not unbounded full plan
- green prompt receives execution contract and not unbounded full plan
- CI-fix prompt receives capped failure output
- DB override still wins

Prompt-shape tests:

- no execution prompt includes unrelated supplements
- no execution prompt includes uncapped CI logs
- no execution prompt includes full plan unless explicitly allowed
- prompt size is logged or measurable by job type and prompt key

## Fail-safe behavior

If prompt loading, rendering, execution-contract parsing, or budget checks fail, the worker should not guess. It should fail the job or request human review depending on the existing handler semantics.

The worker must not use prompt text as a substitute for code-enforced safety checks.
