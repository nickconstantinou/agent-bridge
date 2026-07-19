# Agentic Prompt Contracts

## Status

Canonical target-state architecture for Engineering Worker prompts, lifecycle-skill composition, structured outputs, validators, focused repairs, and completed legacy prompt-override retirement.

## Principle

Prompts and skills are implementation inputs, not authority boundaries.

Agent Bridge owns the role, mode, evidence supplied, tool grants, permission profile, budgets, structured-output schema, validator, repair limit, persistence, and lifecycle transition. A prompt or skill cannot grant tools, change role, expand permission, redefine acceptance criteria, or bypass deterministic or human gates.

## Separation model

Prompts remain separate by role, mode, and stage. Do not create one large orchestration prompt or reuse a code-writing prompt for requirements, planning, review, operations, or documentation.

Each prompt contract has:

- a stable key and contract version;
- one owning role and mode;
- a source-controlled Markdown prompt file;
- a typed input schema and structured output schema;
- an independent deterministic validator;
- an evidence/tool grant and permission profile selected outside the prompt;
- a bounded repair policy;
- an explicit ordered set of canonical lifecycle skills;
- stable prompt-template, skill-set, composed-template, and rendered-content hashes;
- explicit compatibility aliases where an existing prompt key remains usable during migration.

Prompt text, lifecycle know-how, output schema, validator, permission policy, and tool policy are separate artefacts. Canonical role prompts are source-controlled and cannot be replaced by mutable database text.

The implementation registry is `src/agenticPromptContracts.ts`. Canonical prompt files are under `prompts/worker/roles/`. Canonical software-development lifecycle know-how remains under `skills/` and is composed by `src/lifecycleSkillGuidance.ts`.

## Canonical lifecycle skills

The following repository skills are the authoritative reusable lifecycle sources:

| Skill | Owns |
|---|---|
| `requirements-to-acceptance` | goal, assumptions, non-goals, acceptance criteria, verification, and consequential open questions |
| `risk-based-test-strategy` | risk discovery, test-class selection, boundary depth, observability, and residual-risk reporting |
| `red-green-refactor-tdd` | failing test first, smallest green implementation, characterization, refactoring, and focused-to-broad verification |
| `release-readiness-review` | scope, data, flags, rollback, observability, documentation, and post-release validation |

Each `SKILL.md` contains exactly one block delimited by:

```text
<!-- BEGIN AGENT_BRIDGE_RUNTIME_GUIDANCE -->
...
<!-- END AGENT_BRIDGE_RUNTIME_GUIDANCE -->
```

The full skill remains available to humans and native CLI skill discovery. Agent Bridge injects only the marked block. The corresponding `skill.json` name and version must match the runtime registry. Missing, duplicate, empty, oversized, malformed, or version-mismatched guidance fails closed.

Do not copy canonical lifecycle passages into role prompts or compatibility supplements. Role prompts own Agent Bridge-specific instructions: role identity, stage, supplied evidence, output shape, escalation, and authority reminders. Skills own reusable engineering know-how.

## Deterministic composition and audit

Every prompt contract declares `lifecycleSkills` in deterministic order. Loading performs:

1. load and validate the role or compatibility prompt file;
2. load each declared `skill.json` and `SKILL.md`;
3. extract one bounded runtime-guidance block per skill;
4. append only those declared blocks in order;
5. append any additional Agent Bridge-specific supplement registered for a compatibility prompt;
6. render bounded invocation variables;
7. record identities.

Canonical role prompt evidence records:

- role prompt key and version;
- role-template content hash;
- ordered lifecycle skill key, version, and content hash;
- lifecycle skill-set hash;
- composed-template hash before invocation data;
- rendered-content hash after bounded invocation data.

A provider fallback receives the same prompt key, role template, skill set, schemas, validator, and hashes. Only the selected target/model changes.

Changing one skill must change only the composed and rendered identities of prompts that declare that skill. Sibling prompt-template hashes and non-consuming prompt identities remain unchanged.

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

The source mapping in `AGENTIC_PROMPT_LIFECYCLE_SKILLS` is authoritative. Examples:

- Technical Lead requirements and issue modes consume `requirements-to-acceptance`;
- Technical Lead planning consumes requirements, risk-based testing, and TDD;
- Code Worker red consumes risk-based testing and TDD;
- Code Worker green consumes TDD;
- implementation review and PR readiness consume risk-based testing and release readiness;
- operations review consumes release readiness;
- Documentation Steward impact, validation, and maintenance consume release readiness where relevant.

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
- every affected architectural boundary and invariant to structural, integration, acceptance, or Architecture Lint coverage;
- every triggered lifecycle, compatibility, security, data, operations, migration, or rollback risk to an appropriate test class;
- unchanged sibling modes, task types, providers, transports, and public contracts to characterization or regression coverage.

## Red-test quality rules

The Technical Lead planning validator rejects generic test wording, missing production callers, absent expected red failure, helper-only evidence where wiring matters, missing acceptance or architecture traceability, weak lifecycle/security/operations coverage, copied production algorithms in the oracle, unrelated failure modes, and unspecified sibling behaviour.

A valid plan may cite an existing test when it already covers the required boundary. It must identify the exact file/test and explain why it is sufficient. New architectural intent should normally have an acceptance or Architecture Lint red test even when narrow unit coverage exists.

## Focused repair

Full-plan generation and plan repair remain separate prompts.

1. Run `technical_lead:planning` once.
2. Validate the complete plan, including red-test coverage and execution contract.
3. When only the red-test contract is incomplete, run `technical_lead:planning_repair:red_tests` once.
4. When only the execution contract is incomplete, use `technical_lead:planning_repair:execution_contract`.
5. Merge only the repaired section into the original plan.
6. Revalidate the complete artefact before persistence.
7. Fail closed when the bounded repair remains invalid.

A focused repair cannot change requirements, scope, non-goals, architecture, work-packet boundaries, permissions, operations policy, or human gates.

## Prompt storage decision

Prompt text and lifecycle skills are reviewed source artefacts. The SQLite `prompts` table and its runtime override API have been removed.

Canonical and compatibility prompts resolve only from registered repository files. `AgenticPromptContract.allowDatabaseOverride` is always `false`; `loadAgenticPrompt()` and `loadWorkerPrompt()` have no database-template input. Prompt rollback is application rollback to a reviewed SHA.

## Compatibility

Existing feature-planning, defect/refactor scanning, TDD, repair, CI-fix, and orchestrated-task keys remain explicit compatibility aliases while role-native dispatch is introduced.

Compatibility paths:

- resolve source-controlled prompt files only;
- consume the same canonical lifecycle skill loader and fragments as role-native prompts;
- preserve existing validators, permissions, handler ownership, and output contracts;
- cannot silently become canonical role prompts;
- are reported as legacy/degraded once role routing is authoritative;
- are retired only after their replacement role path is qualified.

PR #157's focused execution-contract recovery remains the model for section-specific repair. Issue #159 extends this pattern to comprehensive red-test repair rather than folding repair instructions into the full planning prompt.

## Required verification

Implementation must prove:

- every lifecycle skill has exactly one valid marked guidance block and a matching manifest version;
- every role/mode and compatibility prompt declares its lifecycle skills explicitly;
- missing, duplicated, malformed, oversized, or version-mismatched skill guidance fails closed;
- role/mode prompts remain separate and consume only their declared skills;
- changing one skill changes only consuming skill-set, composed, and rendered hashes;
- provider fallback preserves prompt and lifecycle-skill identities;
- compatibility and role-native prompts share the canonical skill loader rather than copied lifecycle supplements;
- comprehensive red-test validation and focused repair work across supported Technical Lead targets;
- canonical prompts cannot consume database text;
- exact-head tests, typecheck, Architecture Lint, and diff checks pass.
