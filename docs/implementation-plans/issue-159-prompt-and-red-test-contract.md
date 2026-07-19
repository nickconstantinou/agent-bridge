# Issue #159 Addendum — Prompt Separation and Advisor Red-Test Planning

## Status

Normative implementation-plan addendum. This document and `docs/implementation-plans/issue-159-role-based-orchestration.md` together form the approved coding-agent handoff.

## Decisions

1. The Technical Lead owns test-strategy design during implementation planning.
2. The Code Worker implements the approved red-test packet; it does not receive vague instructions such as `write tests` and infer product or architectural intent independently.
3. Prompts remain separate by role, mode, and focused-repair purpose.
4. Canonical role prompts are versioned source-controlled Markdown files registered in `src/agenticPromptContracts.ts`.
5. Canonical role prompts cannot be replaced by database text.
6. The SQLite `prompts` table is a legacy runtime override channel, not a backup. It is retired in stages after row inventory and a separately approved guarded migration.

## Delivered in PR #160

PR #160 now contains:

- the complete canonical prompt registry for all Technical Lead, Code Worker, and Documentation Steward modes;
- one source-controlled prompt file per role/mode under `prompts/worker/roles/`;
- separate Technical Lead red-test and execution-contract repair prompts;
- active legacy implementation-planning prompts strengthened with product, architecture, real-caller, authoritative-oracle, false-positive, sibling, and risk coverage requirements;
- active TDD red/green prompts aligned to the approved red-test contract;
- contract tests proving prompt completeness, separation, source, version, hash, permission intent, and absence of database overrides.

These additions do not yet switch the whole worker lifecycle to role routing. Existing handlers remain compatibility paths until their delivery slice migrates.

## Minimal-change implementation

Extend:

- source-controlled prompt files under `prompts/worker/`;
- `src/workerPrompts.ts` for legacy compatibility prompts;
- `src/agenticPromptContracts.ts` for canonical role prompts;
- `AdvisorService` for Technical Lead execution;
- the implementation-plan schema and quality validator;
- PR #157's section-specific repair pattern.

Do not introduce:

- a second prompt database or prompt service;
- prompt-owned tools, permissions, budgets, or lifecycle policy;
- one shared mega-prompt;
- a new planning handler solely to hold prompt text;
- a second plan validator;
- provider-specific prompt schemas;
- new database prompt overrides.

## Planning output contract

Extend the canonical implementation-plan structured output with:

```ts
type ImplementationPlan = {
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

`RedTestSpec` is defined in `docs/architecture/agentic-prompt-contracts.md` and implemented in the Technical Lead planning prompt.

The human Markdown plan includes `## Red Tests` and `## Red Test Coverage`, generated from validated structured data. Rendered prose is not an independent source of truth.

## Planning validator changes

Extend the existing implementation-plan validator. It must prove:

1. Every acceptance criterion has a mapped red test or justified deterministic non-test proof.
2. Every affected architecture boundary or invariant has appropriate structural/integration coverage.
3. Tests identify the real production caller and authoritative observable result.
4. Tests state why current code fails and the expected red assertion.
5. Tests include a focused command and expected sibling-green behaviour.
6. Product, architecture, compatibility, lifecycle, security, data, operations, migration, and rollback intent are covered where triggered.
7. Generic or placeholder instructions are rejected.
8. Helper-only tests are rejected when production wiring is material.
9. Test oracles do not copy production ranking, parsing, transition, permission, reconciliation, or migration logic.
10. Refactors identify characterization before structural change.
11. Existing tests cited as sufficient are named by exact file/test and mapped to intent.
12. Test targets and commands match repository evidence and ownership.

Validation errors are typed and section-specific so one focused red-test repair can run without reopening the whole plan.

## Prompt registry

The canonical registry owns metadata, not authority:

```ts
type AgenticPromptContract = {
  key: AgenticPromptKey;
  version: 1;
  role: AgentRole;
  mode: string;
  filePath: string;
  outputContract: string;
  source: "builtin";
  allowDatabaseOverride: false;
  compatibilityAliases: string[];
};
```

`loadAgenticPrompt()` reads the registered file, renders bounded inputs, and records a SHA-256 content hash. Agent Bridge separately supplies tools, permissions, budgets, context, lifecycle owner, schema, and validator.

## Database prompt retirement

The source-controlled prompt file is already the fallback for the legacy loader. Therefore the SQLite row is not a backup; it is an override that can silently replace reviewed prompt text.

Removing the override capability is the target decision because prompt changes influence requirements, plans, tests, code mutation, review, and operations. They must therefore have:

- Git history and human review;
- versioned contracts;
- deterministic tests;
- exact-head CI;
- reproducible workspace behaviour;
- content hashes tied to application revisions;
- known rollback.

Do not drop the table in PR #160. The database migration boundary is separately guarded, and existing rows have not been inventoried. Instead:

1. New role prompts reject database overrides now.
2. No new override-management surface is added.
3. Inventory legacy rows by workspace/key without logging content.
4. Move any approved customization into source-controlled files and tests.
5. Disable reads handler by handler during role migration.
6. Remove `setPrompt`, then `getPrompt`, after callers are gone.
7. Drop the table through a dedicated guarded migration with backup, rollback, and representative existing-database tests.

## Focused repair sequence

1. `technical_lead:planning` creates the full plan once.
2. The existing validator checks every section.
3. If only red tests or coverage matrices are invalid, call `technical_lead:planning_repair:red_tests` once.
4. Repair input contains the immutable canonical issue, original plan, evidence references, and typed validation failures.
5. Repair output contains only replacement red-test and coverage sections.
6. Agent Bridge merges those sections and revalidates the complete plan.
7. If only the execution contract is invalid, use `technical_lead:planning_repair:execution_contract`.
8. If multiple substantive sections are invalid, fail the full plan rather than chaining autonomous repairs.

Neither repair can alter requirements, scope, non-goals, architecture, packet boundaries, permissions, operations policy, or human gates.

## Required production-boundary red tests

### 1. Complete prompt registry

- Every documented role/mode resolves one unique registered key and source-controlled file.
- No canonical contract allows a database override.
- Missing or duplicate files fail tests.

### 2. Planning rejects generic test wording

- Process an otherwise valid plan containing only `write unit tests` through the real validator.
- Expect typed missing intent/boundary/oracle/coverage errors and no canonical persistence.

### 3. Product and architecture intent both map

- Validate an architecture-affecting change with behavioural criteria and a public compatibility invariant.
- A narrow helper test alone must fail validation.

### 4. Triggered risks require matching test classes

- A cancellation/retry/lease/restart change with only happy-path tests must fail for missing lifecycle coverage.
- Equivalent security, operations, migration, or rollback triggers require their own classes.

### 5. Structured red-test contract persists and renders

- Validate, persist, reload after simulated restart, and render a plan with multiple `RedTestSpec` records.
- Structured records, prompt key/version/hash, and rendered sections remain equivalent.

### 6. Red-test repair is section-only

- A repair that attempts to change scope or packets is rejected.
- Only red-test and coverage sections can be merged, followed by full revalidation.

### 7. Execution-contract repair remains separate

- PR #157's focused repair continues to use its own key and cannot change red tests or other plan sections.

### 8. Role/mode prompts cannot substitute

- Planning, review, operations, executor, and documentation dispatch resolve their exact keys.
- A fallback model receives the same key, version, schema, validator, and content hash.

### 9. Canonical prompts ignore database text

- Seed a legacy row with conflicting instructions for a canonical key.
- `loadAgenticPrompt()` still loads the reviewed file and records `source: builtin`.

### 10. Legacy retirement is safe

- Inventory existing rows without exposing contents.
- Each migrated handler ignores its row only after compatibility evidence passes.
- Final table removal is migration-tested and rollback-qualified.

## Architecture Lint and structural guards

Add guards proving:

- one central canonical prompt registry;
- prompt text does not define tool, permission, budget, or lifecycle policy;
- role handlers resolve registered prompts rather than embed large independent copies;
- planning and focused repairs use different keys;
- Technical Lead prompts route through `AdvisorService`;
- Code Worker and Documentation Steward prompts cannot be selected for Technical Lead modes;
- canonical prompt loaders cannot import or call DB prompt access;
- compatibility aliases are explicit and cannot silently become canonical.

Avoid brittle full-text snapshots as the primary oracle. Test keys, metadata, required semantic instructions, schemas, validators, content hashes, and isolation. Use focused golden fixtures only where wording itself is contractual.

## Completion criteria

This addendum is complete only when:

- Technical Lead plans cannot pass with generic test instructions;
- comprehensive red-test specifications protect product and architectural intent;
- acceptance, architecture, and risk coverage matrices are validated and durable;
- red-test and execution-contract repair remain separate and bounded;
- every role/mode has a distinct source-controlled prompt contract;
- canonical role prompts cannot consume database overrides;
- legacy rows are inventoried and safely migrated before the table is removed;
- exact-head focused/full tests, typecheck, Architecture Lint, cleanup accounting, and CI pass;
- independent review confirms no prompt path can bypass role, permission, validator, evidence, or lifecycle boundaries.