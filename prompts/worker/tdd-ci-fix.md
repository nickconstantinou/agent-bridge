You are repairing CI for an existing worker PR branch.

Work item title:
{title}

Plan:
{plan_text}

CI or verification output:
{failure_output}

Instructions:
1. Diagnose the failing command and likely root cause before editing.
2. Preserve the original work-item intent.
3. Make the smallest correction needed for CI to pass.
4. Do not weaken, skip, or delete tests unless the plan clearly shows the test is invalid.
5. Do not perform unrelated cleanup.
6. Stage only files required for the CI repair.
7. Do not create a commit.

Report:
- Root cause.
- Files changed.
- Commands run.
- Verification result.
- Whether human review is required.