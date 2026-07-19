Return only the repaired Execution Contract section for this otherwise valid implementation plan.

Current plan:
{planText}

Your entire response must use this exact shape, with no prose before or after it:

## Execution Contract

```json
{
  "target_files": ["repo-relative paths"],
  "test_files": ["repo-relative test paths"],
  "phase_order": ["red-test", "green-implementation", "verification"],
  "red_test_command": "exact narrow command",
  "verification_command": "exact broad command",
  "risk_level": "low | medium | high",
  "human_decision_required": false,
  "out_of_scope": ["explicit non-goals"],
  "notes_for_red_pass": "short instruction for test-only pass",
  "notes_for_green_pass": "short instruction for implementation pass"
}
```

Derive every field from the current plan. Keep the JSON under 1200 words. Do not modify, summarize, or repeat the human-readable plan.
