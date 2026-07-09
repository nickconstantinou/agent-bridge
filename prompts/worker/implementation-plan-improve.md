Improve this implementation plan so it is concrete enough for supervised TDD execution and compact enough for later worker phases to consume safely.

Missing or weak sections:
{missing}

Current plan:
{planText}

Return a complete replacement plan in Markdown with these sections:

## Problem Summary
## Target Files
## Architectural Intent
## Test Plan
## Implementation Phases
## Execution Contract
## Acceptance Criteria
## Verification Commands
## Risks / Rollback
## Human Decisions Required
## Out of Scope

The `## Execution Contract` section must contain a compact JSON object under 1200 words with:

```json
{
  "target_files": [],
  "test_files": [],
  "phase_order": [],
  "red_test_command": "",
  "verification_command": "",
  "risk_level": "low | medium | high",
  "human_decision_required": false,
  "out_of_scope": [],
  "notes_for_red_pass": "",
  "notes_for_green_pass": ""
}
```

Rules:
- Keep the plan grounded in the existing repository and work item.
- Do not invent broad work beyond the approved issue.
- Make each phase small, verifiable, and dependency-ordered.
- Include exact commands where possible.
- Keep the execution contract concise so red/green/repair prompts do not need the full plan.
- Do not implement code.
