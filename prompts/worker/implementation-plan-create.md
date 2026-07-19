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

## Target Files
List concrete repo-relative file paths that will be created or modified. For each file, specify exact classes, functions, methods, interfaces, handlers, repositories, scripts, services, prompts, or tests to be modified or added.

## Architectural Intent
Explain the production path, ownership boundaries, invariants, compatibility requirements, permission constraints, lifecycle authority, and prohibited shortcuts. Include how to avoid test-only code in production and how the intended caller will use the intended abstraction.

## Test Plan
Summarise the risk-based test strategy: behavioural, architecture, lifecycle, compatibility, security, operations, migration, or rollback classes that apply; characterization required before refactoring; focused and broad commands; and unchanged sibling behaviour.

## Red Tests
For every required red test specify:
- stable test ID and mapped acceptance criterion;
- product intent protected;
- architectural boundary or invariant protected;
- triggered lifecycle, compatibility, security, data, operations, migration, or rollback risk protected;
- exact test class, file path, and test name;
- production boundary under test;
- fixture and authoritative initial state;
- action through the real caller rather than a copied helper path;
- expected observable result and authoritative oracle;
- why the current code must fail;
- exact failing assertion or expected failure evidence;
- exact focused red command;
- sibling behaviour that must remain green;
- false-positive controls proving the failure is not syntax, fixture, import, timeout, baseline, or unrelated breakage.

Helper-only tests are insufficient when correctness depends on handler wiring, repository ownership, lifecycle state, permissions, child processes, Git, GitHub, platform desired/effective state, or deployed behaviour. Do not copy production parsing, ranking, transition, permission, reconciliation, or migration logic into the test oracle.

## Red Test Coverage
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
  "red_test_command": "exact narrow command",
  "verification_command": "exact broad command",
  "risk_level": "low | medium | high",
  "human_decision_required": false,
  "out_of_scope": ["explicit non-goals"],
  "notes_for_red_pass": "execute the approved Red Tests section; do not invent or weaken test intent",
  "notes_for_green_pass": "smallest production change satisfying committed red tests and approved intent"
}
```

## Acceptance Criteria
5-8 concrete, binary criteria covering functional behaviour, error handling, safe defaults, performance where material, architectural constraints, compatibility, and applicable lifecycle/security/operations requirements.

## Verification Commands
Exact copy-pasteable focused, subsystem, full-suite, typecheck, Architecture Lint, cleanup/static, diff, migration/rollback, repeated/serial, and exact-head commands required by risk.

## Risks / Rollback
Side effects, backwards compatibility concerns, lifecycle/interruption risks, dependency changes, rollout, authoritative postconditions, and rollback procedure.

## Human Decisions Required
Anything the worker must not decide autonomously. Do not silently choose product behaviour, security posture, compatibility, migration, or production policy.

## Out of Scope
Explicit non-goals and work the implementation must not do.

Do not implement code. Do not restate the issue without a concrete repository-grounded plan. A plan is invalid when product intent, architectural intent, triggered-risk coverage, the real caller boundary, authoritative oracle, expected red failure, or sibling behaviour is unspecified. Keep the Execution Contract compact so later worker phases do not need the full plan.