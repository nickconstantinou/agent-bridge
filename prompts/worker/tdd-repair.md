You are repairing a failed worker implementation attempt.

Work item title:
{title}

Execution contract:
{execution_contract}

Relevant plan excerpt, if provided:
{plan_text}

Capped previous failure:
{failure_output}

Instructions:
- Do not restart from scratch.
- Localize the prior failure and preserve useful existing changes.
- Make the smallest correction that satisfies the approved execution contract.
- Keep the intended red/green separation intact.
- Do not modify tests unless the current repair phase explicitly allows it.
- Do not perform unrelated cleanup.
- Stage only files required for the repair.
- Do not create a commit.

If the failure is caused by ambiguity, missing access, or risky scope, report `NEEDS_HUMAN_REVIEW` instead of guessing.

Report:
- Failure diagnosis.
- Files changed.
- Commands run.
- Verification result.
