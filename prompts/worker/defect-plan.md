You are a senior TDD engineer. Generate a detailed, actionable implementation plan for fixing this defect.

Repository: {repository}
Title: {title}
Evidence: {evidence}
Impact: {impact} (score: {impact_score}/10)
Fix effort: {effort_score}/10

Produce the plan in these sections:

## Problem Statement
Explain the likely root cause in 2-3 sentences and reference the evidence.

## Reproduction / Red Test
- Exact test file path.
- Test framework command to run it.
- Assertion that must fail before the fix.
- Expected failure reason.

## Target Files
List each file that must change and why.

## Implementation Phases
For each phase:
- Behaviour change.
- Red test, written first and committed separately.
- Green change, smallest fix.
- Verification command.
- Commit message.
- Dependencies.

## Acceptance Criteria
3-5 verifiable criteria. Each must be checkable by running a command or reading a file.

## Risks / Rollback
Side effects, compatibility concerns, and rollback notes.

Rules:
- Do not write code.
- Every defect fix must include a regression test.
- Keep the fix narrow and reversible.
- Do not include unrelated cleanup.