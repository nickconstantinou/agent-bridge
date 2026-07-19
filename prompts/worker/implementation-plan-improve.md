Improve this implementation plan so it is concrete enough for supervised TDD execution and compact enough for later worker phases to consume safely.

Missing or weak sections:
{missing}

Current plan:
{planText}

Return a complete replacement plan in Markdown with exactly these sections:

## Problem Summary
## Acceptance Criteria
## Target Files
## Architectural Intent
## Test Plan
## Red Tests
## Red Test Coverage
## Implementation Phases
## Execution Contract
## Verification Commands
## Risks / Rollback
## Human Decisions Required
## Out of Scope

Retain approved requirements, scope, non-goals, architecture, compatibility, permission policy, operations policy, and human gates. Do not delegate test-strategy design to the coding worker with generic wording such as `write tests`, `add coverage`, or `write unit tests`.

`## Acceptance Criteria` must give every approved criterion a stable requirement ID such as `AC-1`.

`## Red Tests` must contain a JSON array. Every object must use this exact shape and contain substantive repository-grounded values:

```json
[
  {
    "id": "RT-1",
    "requirement_ids": ["AC-1"],
    "intent": {
      "product": ["observable product behaviour protected"],
      "architecture": ["ownership or production boundary protected"],
      "invariants": ["behaviour or safety rule that must remain true"],
      "risks": ["triggered lifecycle, compatibility, security, data, operations, migration, or rollback risk"]
    },
    "test_classes": ["behavioural", "architecture", "lifecycle", "compatibility", "security", "operations"],
    "characterization_required": false,
    "test_file": "test/exact-file.test.ts",
    "test_name": "exact test name",
    "production_boundary": "real handler/repository/service/CLI/platform boundary",
    "fixture_and_state": "authoritative initial state and fixtures",
    "action_through_real_caller": "action through the actual production caller, not a copied helper path",
    "expected_observable_result": "persisted state, emitted call, filesystem/Git result, status, API result, or user-visible behaviour",
    "why_current_code_fails": "specific missing or incorrect current behaviour",
    "expected_red_assertion": "exact assertion or expected failure evidence before implementation",
    "focused_red_command": "copy-pasteable narrow command",
    "sibling_behaviour_remaining_green": ["unchanged task/provider/mode/transport/public contract"],
    "authoritative_oracle": "source of truth observed by the test",
    "false_positive_controls": ["how syntax, fixture, import, timeout, baseline, and copied-algorithm failures are excluded"]
  }
]
```

Use only applicable test classes, but do not omit a class triggered by the approved issue or architecture. Helper-only tests are invalid where handler wiring, repositories, lifecycle ownership, permissions, child processes, Git, GitHub, platform status, or deployment behaviour are material. The oracle must not duplicate the production algorithm.

`## Red Test Coverage` must contain one JSON object using these exact keys:

```json
{
  "acceptance_coverage": [
    {"requirement_id":"AC-1", "red_test_ids":["RT-1"], "non_test_proof":null}
  ],
  "architecture_coverage": [
    {"boundary_or_invariant":"", "red_test_ids":["RT-1"], "characterization_test_ids":[]}
  ],
  "triggered_risk_coverage": [
    {"risk":"", "required_test_classes":["lifecycle"], "red_test_ids":["RT-1"]}
  ]
}
```

Map every acceptance criterion, affected architectural boundary/invariant, and triggered risk to a red test or justified deterministic proof. Specify characterization and sibling behaviour that remain green.

The `## Execution Contract` section must contain a compact JSON object under 1200 words with:

```json
{
  "target_files": [],
  "test_files": [],
  "phase_order": [],
  "red_test_ids": [],
  "red_test_command": "",
  "verification_command": "",
  "risk_level": "low | medium | high",
  "human_decision_required": false,
  "out_of_scope": [],
  "notes_for_red_pass": "execute the approved Red Tests section without inventing or weakening intent",
  "notes_for_green_pass": "implement the smallest change satisfying committed red tests and approved intent"
}
```

Rules:
- Keep the plan grounded in the existing repository, canonical issue, and evidence.
- Do not invent broad work or resolve product decisions silently.
- Make each phase small, verifiable, dependency-ordered, and bounded by files or ownership.
- Include exact commands and authoritative expected evidence.
- Preserve compatibility and sibling behaviour unless the issue explicitly changes them.
- Include operational prerequisites, abort conditions, rollback, and postconditions where triggered.
- Keep the execution contract concise so red/green/repair prompts do not need the full plan.
- The plan is invalid if product intent, architectural intent, real caller coverage, expected current failure, authoritative oracle, triggered-risk tests, or sibling behaviour is missing.
- Do not implement code.
