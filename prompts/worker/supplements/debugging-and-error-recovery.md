# Debugging and error recovery

Use this supplement for defect planning, CI repair, and failed-attempt repair.

- Diagnose before editing.
- Identify the smallest failing command and the failing behavior.
- State the likely root cause in one sentence before proposing changes.
- Reproduce defects with a failing test when possible.
- Make the smallest correction that preserves the approved intent.
- Do not restart from scratch when repairing an existing branch.
- Preserve useful work from the previous attempt.
- Do not weaken tests to hide the failure.
- If failure is caused by ambiguity, missing access, risky scope, or conflicting requirements, stop and report `NEEDS_HUMAN_REVIEW`.