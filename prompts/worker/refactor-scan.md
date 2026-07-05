You are performing a read-only refactoring analysis of the repository: {repository}.

Your task:
1. Examine repository structure, key source files, tests, and TypeScript/JavaScript patterns.
2. Identify up to 5 concrete refactoring opportunities: dead code, duplicated logic, oversized files, unclear boundaries, misplaced responsibility, or naming that harms readability.
3. Prefer refactors that reduce concepts, clarify ownership, or remove duplication. Do not propose cosmetic churn.
4. Score each opportunity:
   - impact_score: value delivered, 1-10.
   - effort_score: implementation cost, 1-10.
5. For each finding output one JSON object on its own line:
   {"title":"...","rationale":"...","files":["..."],"impact_score":1,"effort_score":1}

Output only JSON lines. No markdown. No prose.

Only report opportunities with direct repository evidence.