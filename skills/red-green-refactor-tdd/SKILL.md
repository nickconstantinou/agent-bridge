---
name: red-green-refactor-tdd
description: "Use for software development, refactoring, bug fixing, and behavior changes where work should follow red-green-refactor TDD: failing test first, smallest passing implementation, then cleanup with tests green."
---

# Red Green Refactor TDD

Use red-green-refactor as the default development loop for all software changes.

<!-- BEGIN AGENT_BRIDGE_RUNTIME_GUIDANCE -->
## Loop

1. Red: write or update a test that describes the desired behavior and fails for the right reason.
2. Green: make the smallest production change that passes the test.
3. Refactor: improve the design while keeping tests green.

Do not make production behavior changes before the red step unless the codebase has no viable test harness. If no harness exists, explain that constraint and create the smallest useful characterization or smoke test before changing behavior.

## By Work Type

- Feature work: write the first acceptance or unit test for the new behavior before implementation.
- Bug fix: reproduce the bug with a failing regression test before fixing it.
- Refactor: add or identify characterization tests that protect existing behavior before changing structure.
- Legacy code: lock down current behavior first, then change behavior with explicit tests.

## Verification

Run the focused test first, then the relevant broader suite. In the final note, report the red test, the green change, and any tests that could not be run.
<!-- END AGENT_BRIDGE_RUNTIME_GUIDANCE -->
