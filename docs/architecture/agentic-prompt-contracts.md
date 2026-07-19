# Agentic Prompt Contracts

## Status

Canonical target-state architecture for Engineering Worker prompts, structured outputs, validators, focused repairs, and legacy prompt-override retirement.

## Principle

Prompts are implementation inputs, not authority boundaries.

Agent Bridge owns the role, mode, evidence supplied, tool grants, permission profile, budgets, structured-output schema, validator, repair limit, persistence, and lifecycle transition. A prompt cannot grant tools, change role, expand permission, redefine acceptance criteria, or bypass deterministic or human gates.

## Separation model

Prompts remain separate by role, mode, and stage. Do not create one large orchestration prompt or reuse a code-writing prompt for requirements, planning, review, operations, or documentation.

Each prompt contract has:

- a stable key;
- a contract version;
- one owning role and mode;
- a source-controlled Markdown file;
- a typed input schema;
- a structured output schema;
- an independent deterministic validator;
- an evidence/tool grant selected outside the prompt;
- a permission profile selected outside the prompt;
- a bounded repair policy;
- an audit-safe content hash;
- explicit compatibility aliases where an existing prompt key remains usable during migration.

Prompt text, output schema, validator, permission policy, and tool policy are separate artefacts. Canonical role prompts are source-controlled and cannot be replaced by mutable database text.

The implementation registry is `src/agenticPromptContracts.ts`. Canonical prompt files are under `prompts/worker/roles/`.

## Canonical prompt registry

### Technical Lead

| Key | Mode | Purpose |
|---|---|---|
| `technical_lead:requirements` | `requirements` | Gather repository facts, identify assumptions, and surface unresolved product decisions |
| `technical_lead:issue_validation` | `issue_validation` | Validate an apparently complete feature, defect, or refactor issue |
| `technical_lead:issue_authoring` | `issue_authoring` | Produce the canonical issue revision |
| `technical_lead:planning` | `planning` | Produce the implementation plan, comprehensive red-test specifications, work packets, and execution contract |
| `technical_lead:planning_repair:execution_contract` | `planning` repair | Repair only an absent or invalid execution contract when the rest of the plan is valid |
| `technical_lead:planning_repair:red_tests` | `planning` repair | Repair only an absent or inadequate red-test contract when the rest of the plan is valid |
| `technical_lead:executor_guidance` | `executor_guidance` | Assess bounded blocked-worker evidence and recommend one permitted next action |
| `technical_lead:implementation_review` | `implementation_review` | Compare final changes and evidence with the approved issue and plan |
| `technical_lead:operations_review` | `operations_review` | Produce rollout, abort, rollback, migration, and postcondition guidance |
| `technical_lead:pr_readiness` | `pr_readiness` | Produce the final advisory readiness verdict after deterministic gates |

### Code Worker

| Key | Mode | Purpose |
|---|---|---|
| `code_worker:scan:defect` | `scan` | Discover evidence-backed defect candidates under read-only permissions |
| `code_worker:scan:refactor` | `scan` | Discover evidence-backed refactor candidates under read-only permissions |
| `code_worker:investigate` | `investigate` | Gather bounded evidence for one candidate or canonical issue |
| `code_worker:red` | `red` | Implement the approved red-test packet only |
| `code_worker:green` | `green` | Implement the smallest production change satisfying committed red tests |
| `code_worker:repair` | `repair` | Correct a verified defect within the approved packet |
| `code_worker:verify` | `verify` | Run approved verification and return evidence without mutation |

### Documentation Steward

| Key | Mode | Purpose |
|---|---|---|
| `documentation_steward:impact` | `impact` | Determine required document updates from issue, plan, and triggers |
| `documentation_steward:author` | `author` | Create or update manifest-approved documentation paths |
| `documentation_steward:validate` | `validate` | Compare documentation with final code, configuration, and evidence |
| `documentation_steward:maintenance` | `maintenance` | Identify missing or stale canonical repository documents |

## Advisor-authored plan red-test contract

Every Technical Lead implementation plan contains a structured `red_tests` collection. The Code Worker executes this contract; it does not invent the test strategy after planning.

Each red-test specification contains:

```ts
type RedTestSpec = {
  id: string;
  requirement_ids: string[];
  intent: {
    product: string[];
    architecture: string[];
    invariants: string[];
    risks: string[];
  };
  test_classes: Array<
    | "behavioural"
    | "architecture"
    | "lifecycle"
    | "compatibility"
    | "security"
    | "operations"
  >;
  characterization_required: boolean;
  test_file: string;
  test_name: string;
  production_boundary: string;
  fixture_and_state: string;
  action_through_real_caller: string;
  expected_observable_result: string;
  why_current_code_fails: string;
  expected_red_assertion: string;
  focused_red_command: string;
  sibling_behaviour_remaining_green: string[];
  authoritative_oracle: string;
  false_positive_controls: string[];
};
```

The plan also contains a coverage matrix mapping:

- every acceptance criterion to one or more red tests or a justified non-test proof;
- every affected architectural boundary and invariant to a structural, integration, acceptance, or Architecture Lint test;
- every triggered lifecycle, compatibility, security, data, operations, migration, or rollback risk to an appropriate test class;
- unchanged sibling modes, task types, providers, transports, and public contracts to characterization or regression coverage.

## Red-test quality rules

The Technical Lead planning validator rejects a plan when:

- it says only `add tests`, `write unit tests`, `add coverage`, or equivalent generic wording;
- a test lacks the real production boundary or caller action;
- it does not explain why current code must fail;
- it relies only on a helper test where correctness depends on handler wiring, repositories, lifecycle ownership, permissions, child processes, Git, GitHub, platform status, or deployment behaviour;
- acceptance criteria or architectural invariants lack test/proof traceability;
- a refactor lacks characterization of behaviour and public compatibility;
- a lifecycle change lacks relevant cancellation, retry, restart, lease, stale-owner, race, or terminal-state coverage;
- a security/permission change lacks deny-path and credential-isolation coverage;
- an operational change lacks abort, rollback, and authoritative postcondition coverage;
- the test oracle duplicates the production algorithm instead of observing authoritative state or effects;
- the proposed red failure could be caused by syntax, fixture, timeout, import, or unrelated baseline failure rather than missing product behaviour;
- changed behaviour is tested while relevant sibling behaviour is left unspecified.

A valid plan may cite an existing test when it already covers the required boundary. It must identify the exact file/test and explain why it is sufficient. New architectural intent should normally have an acceptance or Architecture Lint red test even when narrow unit coverage exists.

## Focused repair

Full-plan generation and plan repair remain separate prompts.

1. Run `technical_lead:planning` once.
2. Validate the complete plan, including red-test coverage and execution contract.
3. When the plan is otherwise valid but only the red-test contract is incomplete, run `technical_lead:planning_repair:red_tests` once with typed errors and immutable approved context.
4. When only the execution contract is incomplete, use `technical_lead:planning_repair:execution_contract`.
5. Merge only the repaired section into the original plan.
6. Revalidate the complete artefact before persistence.
7. Fail closed when the bounded repair remains invalid.

A focused repair cannot change requirements, scope, non-goals, architecture, work-packet boundaries, permissions, operations policy, or human gates.

## Prompt storage decision

The SQLite `prompts` table is not a backup. The source-controlled Markdown prompt is already the fallback when no row exists. The table is a mutable runtime override channel.

Mutable prompt overrides conflict with the role architecture because they can change consequential planning or execution instructions without:

- a reviewed Git diff;
- a prompt-contract version change;
- exact-head CI;
- deterministic semantic tests;
- reproducible content across workspaces;
- clear rollback to a known application SHA;
- reliable audit of the prompt that generated a plan or mutation.

Canonical role prompts therefore use only source-controlled files. `AgenticPromptContract.allowDatabaseOverride` is always `false`, and `loadAgenticPrompt()` has no database-override input.

The legacy table is retained temporarily only to avoid an unreviewed destructive schema change and to preserve existing legacy prompt paths until their rows are inventoried. No new role prompt, platform setting, or operator workflow may create a database prompt override.

## Legacy override retirement

Retirement is staged:

1. Inventory existing rows by workspace and key without exposing prompt contents in logs.
2. Identify whether any row is actually required or merely duplicates an older built-in prompt.
3. Move approved custom behaviour into reviewed source-controlled prompt files and tests.
4. Disable legacy override reads for each migrated handler and report any ignored row as deprecated configuration.
5. Remove `BridgeDb.setPrompt()` and legacy override write instructions.
6. Remove `BridgeDb.getPrompt()` after all callers are migrated.
7. Drop the `prompts` table only through a separately approved guarded database migration with backup, rollback, and representative existing-database tests.

Dropping the table inside this PR would be unsafe because the production database migration boundary is separately controlled and existing rows have not yet been inventoried. Retaining it temporarily does not make it authoritative or a backup.

## Compatibility

Existing keys such as feature planning, defect/refactor scanning, TDD red/green, repair, and CI-fix prompts remain explicit compatibility aliases while their corresponding legacy handlers are migrated.

Compatibility aliases:

- cannot become canonical role prompts silently;
- are reported as legacy/degraded once role routing is authoritative;
- preserve existing output validators and permissions;
- may read an existing database override only until that specific handler is migrated;
- may not accept new override-management features;
- are retired after the replacement role prompt is qualified and existing rows are inventoried or migrated.

PR #157's focused execution-contract recovery pattern remains the model for section-specific repair. Issue #159 extends this pattern to comprehensive red-test repair rather than folding repair instructions into the full planning prompt.

## Required verification

Implementation must prove:

- every role/mode resolves one distinct registered source-controlled prompt contract;
- planning, review, operations, executor guidance, and documentation prompts cannot be substituted for one another;
- changing one prompt does not alter sibling prompt content or permissions;
- canonical role prompts cannot consume database text;
- fallback models receive the same prompt key, contract version, structured schema, validator, and content hash;
- prompt key/version/hash survive restart and are included in audit metadata;
- comprehensive red-test validation and focused repair work across supported Technical Lead targets;
- legacy prompt rows are inventoried before reads or schema are removed;
- legacy prompt paths remain unchanged until their explicit migration slice.