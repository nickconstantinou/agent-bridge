Create a highly detailed, concrete, implementation-ready plan for this work item. The plan must be actionable enough that a supervised coding worker can execute it without further clarification.

Repository: {repository}
Kind: {kind}
Source: {source}
Title: {title}

Issue / context:
{body}

Return Markdown with exactly these sections:

## Problem Summary
Detailed analysis of the defect, feature, or refactor. Reference existing behavior, file relationships, and why the current design or behavior needs modification.

## Target Files
List concrete repo-relative file paths that will be created or modified. For each file, specify exact classes, functions, methods, interfaces, or tests to be modified or added.

## Architectural Intent
Explain the design principles, boundary conditions, and ownership patterns to preserve or introduce. Include how to avoid leaking test-only code into production.

## Test Plan
Detailed plan for writing tests first:
- Exact test file path.
- Assertion logic, test cases, and inputs/outputs.
- Exact command to run the new test and verify the expected result.
- For features and defects, identify the assertion that should fail before implementation.
- For pure refactors, identify characterization coverage or existing tests that prove behavior is preserved.

## Implementation Phases
Break the work into small red/green or characterize/refactor iterations. For each phase, specify:
- Test or characterization changes.
- Production changes.
- Dependencies.
- Exact verification command.
- Git commit message for test/characterization commit and implementation/refactor commit.
- Estimated size: XS, S, M, or L.

## Execution Contract
Provide a compact JSON object for the worker to pass to later execution phases instead of the full plan. Keep it under 1200 words.

```json
{
  "target_files": ["repo-relative paths"],
  "test_files": ["repo-relative test paths"],
  "phase_order": ["red-test", "green-implementation", "verification"],
  "red_test_command": "exact narrow command",
  "verification_command": "exact broad command",
  "risk_level": "low | medium | high",
  "human_decision_required": false,
  "out_of_scope": ["explicit non-goals"],
  "notes_for_red_pass": "short instruction for test-only pass",
  "notes_for_green_pass": "short instruction for implementation pass"
}
```

## Acceptance Criteria
5-8 concrete, binary criteria covering functional behavior, error handling, safe defaults, performance, and architectural constraints.

## Verification Commands
Exact copy-pasteable shell commands to verify correctness at the end.

## Risks / Rollback
Side effects, backwards compatibility concerns, dependency changes, and rollback procedure.

## Human Decisions Required
Anything the worker should not decide autonomously.

## Out of Scope
Explicit non-goals and work the implementation must not do.

Do not implement code. Do not restate the issue without a concrete plan. Keep the Execution Contract compact so later worker phases do not need the full plan.
