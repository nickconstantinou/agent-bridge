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
Detailed plan for writing failing tests first:
- Exact test file path.
- Assertion logic, test cases, and inputs/outputs.
- Exact command to run the new test and verify failure.
- Skeleton code snippet of the proposed test when useful.

## Implementation Phases
Break the work into small red/green iterations. For each phase, specify:
- Test changes.
- Production changes.
- Dependencies.
- Exact verification command.
- Git commit message for test commit and implementation commit.
- Estimated size: XS, S, M, or L.

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

Do not implement code. Do not restate the issue without a concrete plan.