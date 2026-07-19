# Issue #159 Addendum — Prompt, Decomposition, Plan, and Readiness Contracts

## Status

Normative implementation-plan addendum. This document and `docs/implementation-plans/issue-159-role-based-orchestration.md` together form the approved coding-agent handoff.

## Decisions

1. The Technical Lead owns test-strategy design during implementation planning.
2. The Code Worker implements the approved red-test packet; it does not infer product or architecture intent from vague instructions.
3. Prompts remain separate by role, mode, and focused-repair purpose.
4. Canonical role prompts are versioned source-controlled Markdown files registered in `src/agenticPromptContracts.ts`.
5. Canonical and compatibility prompts cannot be replaced by database text.
6. Reusable requirements, testing, TDD, and readiness know-how remains canonical in repository skills and is composed explicitly.
7. Multi-issue specifications are reviewed as one complete bundle before Agent Bridge mutates GitHub.
8. New and repaired implementation plans require reproducible target-path provenance.
9. Implementation and applicable operations review occur after deterministic verification and before documentation.
10. Verification, review, operations, documentation, readiness, and CI evidence are bound to one exact head.
11. Missing, stale, contradictory, or materially misleading required documentation blocks readiness and must be corrected in the same delivery.

## Delivered in PR #160

PR #160 contains:

- 22 canonical prompt contracts for Technical Lead, Code Worker, and Documentation Steward modes;
- one source-controlled prompt file per role/mode under `prompts/worker/roles/`;
- `technical_lead:decomposition_review` for pre-mutation bundle consistency;
- separate Technical Lead red-test and execution-contract repair prompts;
- active compatibility planning prompts strengthened with comprehensive red tests and structured target provenance;
- active TDD red/green prompts aligned to the approved red-test contract;
- deterministic lifecycle-skill extraction, validation, composition, and hashes;
- exact-head implementation, operations, documentation, and readiness contracts;
- explicit required-versus-actual review independence;
- tests proving prompt completeness, separation, source, version, hashes, permission intent, bundle review, path classification, exact-head ordering, and documentation blocking;
- complete runtime removal of database prompt access and schema migration 2 for safe table retirement.

These additions do not activate the whole role-based lifecycle. Existing handlers remain compatibility paths until their delivery slices migrate.

## Minimal-change implementation

Extend:

- source-controlled prompt files under `prompts/worker/`;
- `src/workerPrompts.ts` for compatibility prompts;
- `src/agenticPromptContracts.ts` for canonical role prompts;
- canonical repository skills and `src/lifecycleSkillGuidance.ts`;
- `AdvisorService` for Technical Lead execution;
- the implementation-plan schema and quality validator;
- the existing focused repair pattern;
- current documentation registry and readiness gates.

Do not introduce:

- a second prompt database or prompt service;
- prompt-owned tools, permissions, budgets, lifecycle policy, or GitHub mutation authority;
- one shared mega-prompt;
- a new planning handler solely to hold prompt text;
- a second workflow engine, plan validator, queue, supervisor, or merge path;
- provider-specific prompt schemas;
- mutable prompt overrides;
- deferred stale documentation as an accepted readiness result.

## Multi-issue decomposition contract

When one request proposes multiple child issues:

1. Author all issue bodies without GitHub mutation.
2. Assemble the complete bundle, canonical invariant table, repository owners, caller paths, and dependencies.
3. Invoke `technical_lead:decomposition_review`.
4. Require separate `implementation_delivery_order` and `runtime_phase_order` outputs.
5. Audit lifecycle/state, permissions, schema/SQL, GitHub mutation, platform/appliance authority, compatibility, repair invalidation, and prohibited duplicate abstractions.
6. Repair all conflicts and rerun review.
7. Permit Agent Bridge issue mutation only after `ready_for_issue_mutation`.

Individual issue validity is insufficient when the bundle is inconsistent.

## Planning output contract

The canonical implementation plan contains:

```ts
type TargetFile = {
  path: string;
  classification:
    | "existing_at_base"
    | "existing_in_dependency"
    | "proposed_new_production"
    | "proposed_new_test";
  owner: string;
  dependency_ref?: string | null;
  rationale: string;
};

type ImplementationPlan = {
  target_files: TargetFile[];
  red_tests: RedTestSpec[];
  acceptance_coverage: Array<{
    requirement_id: string;
    red_test_ids: string[];
    non_test_proof?: string;
  }>;
  architecture_coverage: Array<{
    boundary_or_invariant: string;
    red_test_ids: string[];
    characterization_test_ids?: string[];
  }>;
  triggered_risk_coverage: Array<{
    risk: string;
    required_test_classes: string[];
    red_test_ids: string[];
  }>;
};
```

For `existing_in_dependency`, `dependency_ref` names the dependency PR and exact reviewed ref. A proposed production path identifies the neighbouring current owner and why no existing file is sufficient. Invalid or unclassified paths block approval.

Already-persisted plans created before this provenance contract retain a narrow compatibility validator for concrete target paths. Newly generated and repaired model output always uses the strict validator.

`RedTestSpec` is defined in `docs/architecture/agentic-prompt-contracts.md`. Human Markdown includes `## Target Files`, `## Red Tests`, and `## Red Test Coverage` generated from validated structured data.

## Planning validator

The generated-plan validator proves:

1. Every target path has valid classification, owner, and rationale.
2. Dependency paths include exact dependency evidence.
3. Every acceptance criterion has mapped red tests or justified deterministic proof.
4. Every affected architecture boundary/invariant has structural or integration coverage.
5. Tests identify the real production caller and authoritative observable result.
6. Tests state why current code fails and the expected red assertion.
7. Tests include a focused command and sibling-green behaviour.
8. Product, architecture, compatibility, lifecycle, security, data, operations, migration, and rollback intent are covered where triggered.
9. Generic or placeholder instructions are rejected.
10. Helper-only tests are rejected when production wiring is material.
11. Test oracles do not copy production algorithms.
12. Refactors identify characterization before structural change.
13. Existing tests cited as sufficient identify exact file/test and mapped intent.
14. Required documentation obligations are identified and cannot be deferred when stale.

Validation errors remain typed and section-specific.

## Prompt registry and skill composition

The canonical registry owns metadata, not authority:

```ts
type AgenticPromptContract = {
  key: AgenticPromptKey;
  version: 1;
  role: AgentRole;
  mode: string;
  filePath: string;
  outputContract: string;
  requiredVariables: readonly string[];
  lifecycleSkills: readonly LifecycleSkillKey[];
  source: "builtin";
  allowDatabaseOverride: false;
  compatibilityAliases: string[];
};
```

`loadAgenticPrompt()` loads the registered file, validates and composes declared skills, renders bounded inputs, and records role-template, skill-set, composed-template, and rendered hashes. Agent Bridge separately supplies tools, permissions, budgets, lifecycle owner, schema, validator, exact-head state, and human gates.

## Database prompt retirement

The SQLite prompt table was a mutable override channel, not a backup. PR #160 removes:

- `BridgeDb.getPrompt()` and `setPrompt()`;
- loader database-template options;
- every handler override read;
- the table from fresh database creation.

Schema migration 2 treats an absent table as retired, drops an empty table transactionally, and rejects unexpected rows while preserving schema version 1 and contents. Prompt rollback is application rollback to a reviewed SHA.

## Focused repair sequence

1. `technical_lead:planning` creates the full plan once.
2. The strict generated-plan validator checks every section, including target provenance.
3. If only red tests or coverage matrices are invalid, call `technical_lead:planning_repair:red_tests` once.
4. If only the execution contract is invalid, call `technical_lead:planning_repair:execution_contract` once.
5. Merge only the repaired section.
6. Revalidate the complete plan with the strict validator.
7. Fail closed when bounded repair remains invalid.

Neither repair can alter requirements, scope, non-goals, architecture, packet boundaries, permissions, operations policy, documentation obligation, or human gates.

## Canonical review and documentation sequence

```text
deterministic verification
→ Technical Lead implementation review
→ Technical Lead operations review when triggered
→ Documentation Steward authoring
→ Documentation Steward validation
→ Technical Lead PR readiness
→ exact-head CI
→ human merge gate
```

Implementation review evaluates documentation obligations but does not consume completed documentation. Documentation requires accepted review evidence for the same `subject_head_sha`.

A code-changing repair invalidates verification, implementation review, operations review, documentation, readiness, and CI evidence for the previous head.

Readiness distinguishes `passed`, `failed`, `not_run`, `not_scheduled`, `stale`, and `unknown`. Only authoritative `passed` evidence for the exact current head satisfies a required gate. Required and actual review independence are recorded separately.

## Documentation completion contract

Every document triggered by `agentic-maintenance.yaml` is checked against final exact-head evidence.

- Missing, stale, contradictory, or materially misleading required documents block readiness.
- Required corrections are completed and revalidated in the same delivery.
- A deferred issue, owner assignment, archive recommendation, or future roadmap item does not satisfy readiness.
- When correction requires material scope or authority change, the workflow holds for human approval rather than returning ready.
- `no_documentation_change` remains valid only with rationale, manifest trigger evidence, and Technical Lead validation.

## Required production-boundary tests

1. Complete prompt registry, including decomposition review, resolves unique source files.
2. Multi-issue conflicts produce `revise_bundle` and zero GitHub mutations.
3. Generic test wording fails plan validation.
4. Invalid or unclassified target paths fail generated-plan validation.
5. Dependency paths without exact dependency refs fail validation.
6. Persisted pre-provenance plans retain compatibility while new model output remains strict.
7. Product and architecture intent both map to tests or proof.
8. Triggered lifecycle/security/operations/migration risks require matching test classes.
9. Structured red-test contracts persist and render across restart.
10. Red-test repair and execution-contract repair remain section-only and separate.
11. Fallback models preserve prompt, skill, schema, validator, and hash identity.
12. Canonical and compatibility prompts ignore database text.
13. Implementation review precedes documentation.
14. Code repair invalidates all later prior-head evidence.
15. `not_scheduled` and stale evidence cannot be reported as green.
16. Stale required documentation blocks readiness until corrected.
17. Migration 2 safely retires absent/empty prompt storage and fails closed on rows.

## Completion criteria

This addendum is complete only when:

- the 22 prompt contracts are source-controlled and isolated;
- multi-issue mutation requires bundle-wide consistency;
- new plans cannot pass generic tests or unclassified paths;
- comprehensive red tests protect product and architecture intent;
- focused repairs remain separate and bounded;
- prompt/skill identity and fallback are deterministic;
- mutable database prompt precedence remains absent;
- review, operations, documentation, readiness, and CI are exact-head-bound;
- stale required documentation cannot be deferred;
- exact-head focused/full tests, typecheck, Architecture Lint, cleanup accounting, diff checks, and CI pass;
- independent review confirms no prompt path bypasses authority boundaries.
