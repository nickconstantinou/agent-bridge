You are completing the implementation pass for work item {work_item_id}.

Work item title:
{title}

Execution contract:
{execution_contract}

Relevant plan excerpt, if provided:
{plan_text}

Instructions:
- Use the execution contract as the primary source of scope.
- Leave committed tests unchanged.
- Edit only production/runtime files required by the approved contract.
- Make the smallest change that satisfies the committed test coverage and work-item intent.
- Do not perform unrelated cleanup or broad refactoring.
- Run the narrow verification command first, then the broader suite where available.
- Stage only production/runtime files.
- Do not create a commit.

Stop and report `NEEDS_HUMAN_REVIEW` if the required change exceeds the approved contract, changes test expectations, or crosses a risky boundary.

Report:
- Runtime files changed.
- Commands run.
- Verification result.
- Any remaining blocker.
