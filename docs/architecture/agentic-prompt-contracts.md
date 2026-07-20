# Agentic Prompt Contracts

## Status

Canonical target-state architecture for Engineering Worker prompts, lifecycle-skill composition, structured outputs, validators, focused repairs, pre-mutation decomposition review, exact-head lifecycle evidence, role-separated Technical Lead review, and completed legacy prompt-override retirement.

## Principle

Prompts and skills are implementation inputs, not authority boundaries.

Agent Bridge owns the role, mode, evidence supplied, tool grants, permission profile, budgets, structured-output schema, validator, repair limit, persistence, lifecycle transition, issue mutation, exact-head binding, and human gates. A prompt or skill cannot grant tools, change role, expand permission, redefine acceptance criteria, mutate GitHub, or bypass deterministic or human gates.

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
- exact subject-head identity for verification, review, operations, documentation, readiness, CI, and final-review phases where applicable;
- explicit compatibility aliases where an existing prompt key remains usable during migration.

Prompt text, lifecycle know-how, output schema, validator, permission policy, and tool policy are separate artefacts. Canonical role prompts are source-controlled and cannot be replaced by mutable database text.

The implementation registry is `src/agenticPromptContracts.ts`. Canonical prompt files are under `prompts/worker/roles/`. Canonical software-development lifecycle know-how remains under `skills/` and is composed by `src/lifecycleSkillGuidance.ts`.

## Canonical lifecycle skills

| Skill | Owns |
|---|---|
| `requirements-to-acceptance` | Goal, assumptions, non-goals, acceptance criteria, verification, consequential open questions, and cross-issue bundle consistency before mutation |
| `risk-based-test-strategy` | Risk discovery, test-class selection, boundary depth, observability, and residual-risk reporting |
| `red-green-refactor-tdd` | Failing test first, smallest green implementation, characterization, refactoring, and focused-to-broad verification |
| `release-readiness-review` | Scope, data, flags, rollback, observability, exact-head evidence, current documentation, role-separated review, and post-release validation |

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
| `technical_lead:decomposition_review` | `decomposition_review` | Audit a complete proposed child-issue bundle against one canonical invariant table before GitHub issue mutation |
| `technical_lead:planning` | `planning` | Produce the implementation plan, classified target paths, comprehensive red-test specifications, work packets, and execution contract |
| `technical_lead:planning_repair:execution_contract` | `planning` repair | Repair only an absent or invalid execution contract when the rest of the plan is valid |
| `technical_lead:planning_repair:red_tests` | `planning` repair | Repair only an absent or inadequate red-test contract when the rest of the plan is valid |
| `technical_lead:executor_guidance` | `executor_guidance` | Assess bounded blocked-worker evidence and recommend one permitted next action |
| `technical_lead:implementation_review` | `implementation_review` | Compare exact-head code and deterministic evidence with the approved issue and plan before documentation |
| `technical_lead:operations_review` | `operations_review` | Produce exact-head rollout, abort, rollback, migration, and postcondition guidance before documentation |
| `technical_lead:pr_readiness` | `pr_readiness` | Produce advisory readiness and, in a fresh post-CI invocation, the final exact-head Technical Lead review verdict |

The final review does not create a fourth role or require a 23rd prompt contract. Agent Bridge invokes the existing read-only Technical Lead readiness contract again after exact-head CI with the final evidence set and records that invocation as `technical_lead_final_review`.

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
| `documentation_steward:author` | `author` | After accepted exact-head review, create or update every required manifest-approved documentation path |
| `documentation_steward:validate` | `validate` | Compare all required documentation with final exact-head code, configuration, review, and operations evidence |
| `documentation_steward:maintenance` | `maintenance` | Identify and require correction of missing, stale, contradictory, or misleading canonical repository documents |

The source mapping in `AGENTIC_PROMPT_LIFECYCLE_SKILLS` is authoritative. Requirements and issue modes consume `requirements-to-acceptance`; decomposition review consumes requirements, risk-based testing, and release readiness; planning consumes requirements, risk-based testing, and TDD; Code Worker red consumes risk-based testing and TDD; green consumes TDD; implementation review and PR readiness consume risk-based testing and release readiness; operations review consumes release readiness; Documentation Steward modes consume release readiness where relevant.

## Pre-mutation decomposition review

When one request creates or updates multiple child issues, Agent Bridge must assemble the full proposed issue bundle before GitHub mutation and invoke `technical_lead:decomposition_review`.

The review returns implementation delivery order, runtime phase order, and one canonical invariant matrix covering current owner and caller path, lifecycle/state authority, permissions, schema/SQL ownership, GitHub mutation authority, platform desired versus appliance effective authority, repair invalidation, compatibility, and prohibited duplicate abstractions.

Issue mutation is allowed only after a `ready_for_issue_mutation` verdict. Agent Bridge then retains the exact pre-mutation body/revision, performs a guarded write, refetches the stored issue, and semantically verifies the approved requirements, invariants, acceptance criteria, evidence, non-goals, dependencies, and human gates.

## Target-path provenance

Every implementation plan classifies every production and test path as exactly one of:

- `existing_at_base`;
- `existing_in_dependency`;
- `proposed_new_production`;
- `proposed_new_test`.

Each target record includes path, classification, owner, dependency ref where applicable, and rationale. Dependency-owned paths name the dependency PR and exact reviewed ref. Proposed production paths identify the neighbouring owner they extend and why no current file is sufficient.

`validateGeneratedImplementationPlan(...)` rejects malformed target JSON, invalid or unclassified paths, missing owners/rationale, and dependency paths without an exact dependency reference. Already-persisted pre-provenance plans retain only the narrow concrete-path compatibility validator.

## Advisor-authored plan red-test contract

Every Technical Lead implementation plan contains a structured `red_tests` collection. The Code Worker executes this contract; it does not invent the test strategy after planning.

Each red-test specification records requirement IDs, product and architecture intent, invariants, risks, applicable test classes, characterization, exact test file/name, production boundary, fixture/state, action through the real caller, expected observable result, why current code fails, expected red assertion, focused command, sibling behaviour, authoritative oracle, and false-positive controls.

The plan also contains coverage matrices for acceptance criteria, affected architecture/invariants, triggered lifecycle/security/operations/migration risks, and unchanged sibling modes, task types, providers, transports, and public contracts.

The planning validator rejects generic test wording, missing production callers, absent expected red failure, helper-only evidence where wiring matters, missing traceability, weak triggered-risk coverage, copied production algorithms in the oracle, unrelated failure modes, unspecified sibling behaviour, and invalid or unclassified target paths.

Red evidence must be empirical. Authored tests, static inspection, expected-only failures, or `not_run` do not permit green implementation.

## Review independence

Independent final review is performed through the read-only Technical Lead AdvisorService path.

The independence basis is:

- reviewer role is `technical_lead`;
- reviewer did not author or modify the implementation under review;
- the review invocation has no mutation authority;
- the invocation is fresh and bound to the exact checked `subject_head_sha`.

Issue #161 adds an independent-frontier requirement to these role/authority controls: a same-model fresh session is `non_independent`. Prior read-only Technical Lead requirements, planning, decomposition, guidance, implementation review, or operations review does not disqualify an otherwise independent final reviewer. The Code Worker cannot review its own mutation. A head change requires a fresh invocation.

## Review, documentation, and readiness order

The canonical runtime order is:

```text
deterministic verification
→ Technical Lead implementation review
→ Technical Lead operations review when triggered
→ Documentation Steward authoring and validation
→ Technical Lead PR readiness
→ exact-head CI
→ fresh exact-head Technical Lead final review
→ human merge gate
```

Implementation review evaluates documentation obligations but does not consume completed documentation. Documentation authoring and validation require accepted implementation and applicable operations review for the same exact `subject_head_sha`.

A code-changing repair invalidates deterministic verification, implementation review, operations review, documentation evidence, readiness, exact-head CI, and final Technical Lead review for the previous head. Every phase must be rerun against the new head.

Readiness distinguishes `passed`, `failed`, `not_run`, `not_scheduled`, `stale`, and `unknown`. Only authoritative `passed` evidence for the exact current head satisfies a required gate.

Missing, stale, contradictory, or materially misleading required documentation is a blocking condition. It must be corrected and revalidated in the same delivery. Documentation changes are trigger-bounded; a broad rewrite requires full-document revalidation against current code and operational evidence.

## Focused repair

Full-plan generation and plan repair remain separate prompts.

1. Run `technical_lead:planning` once.
2. Validate the complete plan, including target-path provenance, red-test coverage, and execution contract.
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

Compatibility paths resolve source-controlled prompts only, consume the same canonical lifecycle skill loader, preserve existing validators and permission ownership, cannot silently become canonical role prompts, are reported as legacy/degraded once role routing is authoritative, and retire only after replacement qualification.

## Required verification

Implementation must prove:

- every lifecycle skill has exactly one valid marked guidance block and a matching manifest version;
- every role/mode and compatibility prompt declares its lifecycle skills explicitly;
- missing, duplicated, malformed, oversized, or version-mismatched skill guidance fails closed;
- role/mode prompts remain separate and consume only declared skills;
- changing one skill changes only consuming skill-set, composed, and rendered hashes;
- provider fallback preserves prompt and lifecycle-skill identities;
- compatibility and role-native prompts share the canonical skill loader;
- multi-issue decomposition cannot mutate issues before bundle-wide invariant review and guarded post-write verification;
- implementation plans reject invalid or unclassified target paths;
- observed intended red failure precedes green;
- implementation review precedes documentation;
- exact-head CI precedes fresh final Technical Lead review;
- same-model Technical Lead review is `non_independent` for Issue #161 even when role/authority separation is preserved;
- Code Worker self-review is rejected;
- stale required documentation blocks readiness and cannot be deferred;
- canonical prompts cannot consume database text;
- exact-head tests, typecheck, Architecture Lint, cleanup/static, and diff checks pass.
