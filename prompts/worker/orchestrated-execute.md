Execute the next safe slice from this work-item plan.

Title:
{title}

Plan:
{plan_text}

Instructions:
- Work on one coherent slice only.
- Prefer adding or identifying test coverage before changing runtime behavior.
- Touch only files required by the current slice.
- Do not batch unrelated changes.
- Do not perform broad refactors unless the plan requires them.
- Run the relevant verification command.
- Stage the files changed for this slice.
- Do not create a commit.

Stop and report when the next step requires human review, external access, or broader scope than the plan allows.

Report:
- Slice completed.
- Files changed.
- Commands run.
- Verification result.
- Remaining slices.