# Agentic Maintenance Workflow

## Status

Canonical operating model. This document describes the implemented Engineering Worker workflow for feature, defect, and refactor changes.

## Principles

1. Agent Bridge orchestrates the workflow and owns authoritative state.
2. Incoming requests, imported issues, and scan findings are inputs, not assumed-complete specifications.
3. The Technical Lead gathers or validates requirements before planning.
4. The Technical Lead designs the implementation and red-test strategy; the Code Worker executes bounded packets.
5. Reusable requirements, test-strategy, TDD, and release-readiness know-how remains canonical in repository skills and is composed explicitly into each relevant prompt mode.
6. The Code Worker performs bounded repository investigation and mutation under mode-specific permissions.
7. The Documentation Steward keeps canonical documents aligned with final code and operations.
8. Deterministic evidence outranks model claims.
9. Humans retain product decisions, merge authority, destructive actions, deployments, and policy exceptions.

## Roles

### Technical Lead

The Technical Lead is the strongest available read-only reasoning path. It owns requirements discovery, issue authoring and validation, planning, comprehensive red-test design, task decomposition, bounded executor guidance, implementation review, operations assessment, and PR-readiness advice.

It does not edit files, execute unrestricted commands, mutate GitHub, merge, deploy, or approve its own output.

### Code Worker

The Code Worker performs repository scans, focused investigation, TDD implementation, repair, and verification. Agent Bridge selects a read-only or mutating permission profile for each mode.

A scan result is a candidate. The Code Worker cannot promote its own finding into approved implementation work or independently redefine the approved test strategy.

### Documentation Steward

The Documentation Steward assesses documentation impact and updates approved documentation paths after implementation facts and evidence are available. It validates that current documents describe the final code, configuration, and operating procedure.

## Common intake lifecycle

```text
Raw input
→ classify feature | defect | refactor
→ gather repository and documentation evidence
→ identify facts, assumptions, conflicts, and unresolved decisions
→ obtain human decisions where required
→ write canonical issue
→ validate issue schema and evidence
→ Technical Lead final validation
→ requirements_ready
```

An apparently complete issue can pass without additional questions, but it never bypasses validation.

## Feature issue contract

A canonical feature issue contains:

- problem or opportunity;
- affected users and use cases;
- desired outcome;
- current behaviour;
- required user, API, or operational behaviour;
- failure behaviour;
- scope and explicit non-goals;
- constraints and compatibility requirements;
- security and data impact;
- documentation and operational impact;
- rollout or adoption requirements;
- binary acceptance criteria;
- verification for every criterion;
- unresolved product decisions.

## Defect issue contract

A canonical defect issue contains:

- observed behaviour;
- expected behaviour;
- reproduction or authoritative evidence;
- affected versions, surfaces, and entry points;
- severity and blast radius;
- facts separated from root-cause hypotheses;
- regression-test requirement at the failing boundary;
- scope and non-goals;
- safe-resolution criteria;
- documentation, compatibility, and operational impact;
- binary acceptance criteria and verification.

A root cause need not be proven before approval, but unsupported hypotheses cannot be presented as fact.

## Refactor issue contract

A canonical refactor issue contains:

- concrete maintainability or architectural evidence;
- affected ownership boundary;
- behavioural and compatibility invariants;
- intended structural change;
- measurable benefit or risk reduction;
- characterization and regression strategy;
- scope and explicit non-goals;
- compatibility retirement conditions where relevant;
- documentation and operational impact;
- binary acceptance criteria and verification.

A refactor is rejected when its only justification is subjective cleanliness, symmetry, or consistency.

## Candidate finding decisions

Defect and refactor scans produce candidate findings. The Technical Lead returns exactly one disposition:

- `validated_issue`;
- `needs_more_evidence`;
- `needs_human_decision`;
- `duplicate_or_superseded`;
- `not_justified`;
- `split_into_multiple_issues`.

Only `validated_issue` proceeds to canonical issue authoring and planning.

## Planning contract

The Technical Lead creates the implementation plan only after `requirements_ready`. The plan includes:

- requirement-to-change traceability;
- affected architecture and ownership boundaries;
- target and test files based on current evidence;
- red-green-refactor phases;
- comprehensive structured red-test specifications;
- acceptance, architecture/invariant, and triggered-risk coverage matrices;
- bounded Code Worker packets;
- dependencies and sequencing;
- invariants and prohibited scope;
- deterministic verification commands;
- documentation obligations;
- rollout, rollback, and migration requirements;
- conditions that return to requirements or human decision;
- a validated machine-readable execution contract.

Each red-test specification identifies:

- acceptance criteria and product intent protected;
- architecture boundaries, invariants, and risks protected;
- test classes such as behavioural, architecture, lifecycle, compatibility, security, and operations;
- exact test file and test name;
- production boundary and fixture/state;
- action through the real caller path;
- expected authoritative observable result;
- why current code must fail;
- expected failing assertion and focused red command;
- sibling behaviour that must remain green;
- characterization required before change;
- authoritative oracle and false-positive controls.

Generic instructions such as `write tests`, `add unit tests`, or `increase coverage` are invalid. Helper-only tests are invalid when correctness depends on production wiring, persistence, permissions, lifecycle, child processes, Git/GitHub, platform status, or operations.

Every acceptance criterion maps to one or more red tests or a justified deterministic non-test proof. Every affected architecture boundary/invariant and triggered lifecycle, compatibility, security, operations, migration, or rollback risk maps to appropriate coverage.

Plan structural validation and bounded repair remain fail-closed before persistence. Full planning, red-test repair, and execution-contract repair use separate prompt contracts. Focused repair may replace only the invalid section and the complete plan is revalidated.

Canonical prompt and red-test contracts:

- `docs/architecture/agentic-prompt-contracts.md`;
- `docs/implementation-plans/issue-159-prompt-and-red-test-contract.md`.

## Prompt and lifecycle-skill separation

Every role and mode has a distinct registered prompt contract. Prompt text, structured schema, validator, evidence/tool grants, permissions, budgets, and lifecycle policy remain separate.

Reusable lifecycle knowledge is authoritative in exactly four versioned repository skills:

- `requirements-to-acceptance`;
- `risk-based-test-strategy`;
- `red-green-refactor-tdd`;
- `release-readiness-review`.

Each role/mode and compatibility prompt declares an ordered `lifecycleSkills` set. `src/lifecycleSkillGuidance.ts` validates the matching manifest and one marked runtime-guidance block, enforces budgets and uniqueness, and composes only the declared skills. Prompts own role/stage/output instructions; skills own reusable engineering know-how; code owns authority and deterministic gates.

Changing a skill affects only consuming prompts' skill-set, composed-template, and rendered hashes. Provider fallback preserves the same prompt and skill identities. Missing markers, duplicate blocks, empty or oversized content, manifest/version drift, or duplicate injection fails closed.

Canonical and compatibility prompts are versioned source-controlled files and never consume database prompt text. The legacy prompt table, accessors, loader override options, and handler reads were removed in schema migration 2. Legacy prompt keys remain explicit source-file compatibility aliases until the corresponding role path is qualified; they cannot change role, mode, tools, permissions, schema, validator, repair count, lifecycle authority, or human gates.

## Execution

Each Code Worker packet contains one coherent objective, permitted files or boundaries, acceptance criteria, approved `RedTestSpec` records, non-goals, relevant evidence, exact verification, and escalation conditions.

The Code Worker implements the planned red tests and proves they fail for the specified reason before green implementation. It returns structured evidence rather than a readiness claim. Agent Bridge validates repository state and deterministic results before asking the Technical Lead for review.

## Review and operations

The Technical Lead performs implementation review and operations review as separate modes under the same configurable role.

Implementation review checks issue satisfaction, scope, invariants, completion of the approved red-test contract, regression coverage, security, architecture, and unsupported claims.

Operations review activates for deployment, services, configuration, credentials, databases, migrations, queues, rollback, backup, or production verification. It defines prerequisites, steps, abort conditions, rollback, postconditions, and required runbook changes.

A different model from the implementing Code Worker is preferred when available. Lack of model diversity is reported explicitly rather than treated as independent review.

## Documentation lifecycle

During planning, the Documentation Steward produces a structured impact assessment. After implementation verification, it updates or creates required documents using the repository registry in `agentic-maintenance.yaml`.

Required document classes include:

- README and user entry points;
- agent execution policy;
- architecture and data flows;
- prompt and lifecycle-skill contracts;
- architecture decisions;
- configuration reference;
- operations and recovery runbooks;
- testing and verification contracts;
- this maintenance workflow;
- machine-readable document triggers.

PR readiness requires either current required documentation or a validated `no_documentation_change` result with rationale.

## Completion evidence

A completed workflow records:

- canonical issue version;
- approved plan and execution contract;
- approved red-test specifications and coverage matrices;
- role target and model;
- prompt key/version/source and role-template hash;
- ordered lifecycle skill key/version/content hashes and skill-set hash;
- composed-template and rendered invocation hashes used for each logical call;
- permission profile used by each invocation;
- red and green commit evidence;
- focused and broad deterministic verification;
- Technical Lead verdicts;
- documentation impact and changed documents;
- operational qualification where applicable;
- unresolved risk and human approvals;
- retrospective result.

## Retrospective

Every non-trivial change ends with a bounded retrospective. Recurring or systemic defects produce the smallest durable prevention: code guard, test, prompt-contract correction, skill update, documentation correction, or proposed `AGENTS.md` rule. One-off preferences do not justify new global rules.
