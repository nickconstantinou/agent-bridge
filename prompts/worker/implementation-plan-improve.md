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
## Red Tests
## Red Test Coverage
## Implementation Phases
## Execution Contract
## Acceptance Criteria
## Verification Commands
## Risks / Rollback
## Human Decisions Required
## Out of Scope

The improved plan must retain approved requirements and scope. It must not delegate test-strategy design to the coding worker with generic wording such as `write tests`, `add coverage`, or `write unit tests`.

For every item in `## Red Tests`, require:
- mapped acceptance criterion and product intent;
- architectural boundary or invariant;
- applicable lifecycle, compatibility, security, data, operations, migration, or rollback risk;
- exact test class, file, and name;
- production boundary, fixture/state, and action through the real caller;
- expected observable result and authoritative oracle;
- why current code fails and exact expected red assertion;
- focused red command;
- sibling behaviour remaining green;
- characterization needs and false-positive controls.

`## Red Test Coverage` must map every acceptance criterion, affected architectural boundary/invariant, and triggered risk to a red test or justified deterministic proof. Helper-only tests are invalid where handler wiring, repositories, lifecycle ownership, permissions, child processes, Git, GitHub, platform status, or deployment behaviour are material. The oracle must not duplicate the production algorithm.

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