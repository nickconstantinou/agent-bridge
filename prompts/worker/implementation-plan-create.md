Create a highly detailed, concrete, implementation-ready plan for this work item. The plan must be actionable enough that a supervised coding worker can execute it without further clarification.

Repository: {repository}
Kind: {kind}
Source: {source}
Title: {title}

Issue / context:
{body}

The test strategy belongs to the plan author. Do not delegate product or architectural interpretation to the coding worker with generic instructions such as `write tests`, `add tests`, or `increase coverage`.

Return Markdown with exactly these sections:

## Problem Summary
Detailed analysis of the defect, feature, or refactor. Reference existing behavior, file relationships, evidence, and why the current design or behavior needs modification.

## Acceptance Criteria
Give every criterion a stable requirement ID such as `AC-1`. Provide 5-8 concrete, binary criteria covering functional behaviour, error handling, safe defaults, performance where material, architectural constraints, compatibility, and applicable lifecycle/security/operations requirements.

## Target Files
Provide a JSON array. Every referenced path must use this exact shape:

```json
[
  {
    "path": "src/exact-file.ts",
    "classification": "existing_at_base | existing_in_dependency | proposed_new_production | proposed_new_test",
    "owner": "current owning module or boundary",
    "dependency_ref": null,
    "rationale": "why this path changes or why a new file is required"
  }
]
```

For `existing_in_dependency`, name the dependency PR and exact reviewed ref. For a proposed production file, name the neighbouring owner it extends and why no existing file is sufficient. Any invalid or unclassified path blocks approval.

## Architectural Intent
Explain the production path, ownership boundaries, invariants, compatibility requirements, permission constraints, lifecycle authority, and prohibited shortcuts. Include how to avoid test-only code in production and how the intended caller will use the intended abstraction.

## Test Plan
Summarise the risk-based strategy, characterization required before refactoring, production boundaries, applicable test classes, focused and broad commands, and unchanged sibling behaviour. The structured Red Tests and Red Test Coverage sections below are authoritative.

## Red Tests
Provide a JSON array. Every object must use this exact shape and contain substantive repository-grounded values:

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

Use only applicable test classes, but do not omit a class triggered by the issue or architecture. Helper-only tests are insufficient when correctness depends on handler wiring, repository ownership, lifecycle state, permissions, child processes, Git, GitHub, platform desired/effective state, or deployed behaviour. Do not copy production parsing, ranking, transition, permission, reconciliation, or migration logic into the oracle.

## Red Test Coverage
Provide one JSON object using these exact keys:

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

Map every acceptance criterion to one or more red tests or a justified deterministic non-test proof. Map every affected architectural boundary/invariant to acceptance, integration, structural, or Architecture Lint coverage. Map every triggered risk to the appropriate test class. Identify characterization and regression coverage for unchanged public contracts, task types, providers, modes, and transports.

## Implementation Phases
Break the work into small red/green or characterize/refactor iterations. For each phase, specify:
- linked acceptance criteria and red tests;
- test or characterization changes;
- production changes;
- permitted files or ownership boundary;
- dependencies and non-goals;
- exact verification command and expected evidence;
- escalation conditions;
- Git commit message for test/characterization commit and implementation/refactor commit;
- estimated size: XS, S, M, or L.

## Execution Contract
Provide a compact JSON object for the worker to pass to later execution phases instead of the full plan. Keep it under 1200 words.

```json
{
  "target_files": ["repo-relative paths"],
  "test_files": ["repo-relative test paths"],
  "phase_order": ["red-test", "green-implementation", "verification"],
  "red_test_ids": ["RT-1"],
  "red_test_command": "exact narrow command",
  "verification_command": "exact broad command",
  "risk_level": "low | medium | high",
  "human_decision_required": false,
  "out_of_scope": ["explicit non-goals"],
  "notes_for_red_pass": "execute the approved Red Tests section; do not invent or weaken test intent",
  "notes_for_green_pass": "smallest production change satisfying committed red tests and approved intent"
}
```

## Verification Commands
Exact copy-pasteable focused, subsystem, full-suite, typecheck, Architecture Lint, cleanup/static, diff, migration/rollback, repeated/serial, and exact-head commands required by risk.

## Risks / Rollback
Side effects, backwards compatibility concerns, lifecycle/interruption risks, dependency changes, rollout, authoritative postconditions, and rollback procedure.

## Human Decisions Required
Anything the worker must not decide autonomously. Do not silently choose product behaviour, security posture, compatibility, migration, or production policy.

## Out of Scope
Explicit non-goals and work the implementation must not do.

Do not implement code. Do not restate the issue without a concrete repository-grounded plan. A plan is invalid when a target path is invalid or unclassified, product intent, architectural intent, triggered-risk coverage, the real caller boundary, authoritative oracle, expected red failure, or sibling behaviour is unspecified. Stale required documentation must be corrected in the same delivery before readiness rather than deferred. Keep the Execution Contract compact so later worker phases do not need the full plan.
