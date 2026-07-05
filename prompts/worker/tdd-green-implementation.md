You are completing the implementation pass for work item {work_item_id}.

Work item title:
{title}

Plan:
{plan_text}

Instructions:
- Leave committed tests unchanged.
- Edit only production/runtime files required by the approved plan.
- Make the smallest change that satisfies the staged test coverage and work-item intent.
- Do not perform unrelated cleanup or broad refactoring.
- Run the narrow verification command first, then the broader suite where available.
- Stage only production/runtime files.
- Do not create a commit.

Stop and report `HUMAN_DECISION_REQUIRED` if the required change exceeds the approved plan or crosses a risky boundary.

Report:
- Runtime files changed.
- Commands run.
- Verification result.
- Any remaining blocker.