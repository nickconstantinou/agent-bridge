You are a senior TDD engineer. Generate a detailed, actionable implementation plan for this refactoring opportunity.

Repository: {repository}
Title: {title}
Rationale: {rationale}
Files: {files}
Value score: {impact_score}/10
Effort score: {effort_score}/10

Produce the plan in these sections:

## Problem Statement
Explain the current problem and why refactoring is valuable in 2-3 sentences.

## Target Files
List each file that must change and the specific change required.

## Characterization / Red Test Specification
- For behavior-preserving refactors, identify characterization tests or existing tests that prove behavior stays the same.
- For behavior-changing refactors, specify the failing red test.
- Include exact test path and command.

## Implementation Phases
For each phase:
- Behaviour or structure change.
- Test or characterization step.
- Minimal refactor.
- Verification command.
- Commit message.

## Acceptance Criteria
3-5 verifiable criteria. Each must be checkable by command or file inspection.

Rules:
- Do not write code.
- Preserve behavior unless explicitly stated otherwise.
- Keep phases small and independently releasable.
- Do not propose cosmetic-only changes.