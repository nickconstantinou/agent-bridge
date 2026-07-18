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

When you can complete the slice, report normally.

When you genuinely cannot make safe progress and need a second opinion, do not invoke an advisor command directly. Return exactly one marker followed by one JSON object:

AGENT_BRIDGE_BLOCKED_RESULT: {"status":"BLOCKED","reason":"NEEDS_ADVISOR","hypothesis":"bounded current hypothesis","attempted_steps":["bounded step"],"failing_evidence":"bounded concrete failure","relevant_files":["relative/path.ts"],"decision_needed":"specific decision or missing fact"}

Do not include secrets, credentials, full unbounded logs, hidden reasoning, or unrelated repository context. Use BLOCKED only after making the reasonable attempts allowed by the plan. Stop and use a normal human-review report when the next step requires external access or broader authorised scope rather than technical diagnosis.

Normal completion report:
- Slice completed.
- Files changed.
- Commands run.
- Verification result.
- Remaining slices.
