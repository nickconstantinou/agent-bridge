# Agentic Maintenance Workflow

## Status

Canonical operating model. This document describes the Engineering Worker workflow for feature, defect, and refactor changes. Target-state phases remain dormant until their owning Issue #159 slices are implemented and qualified.

## Principles

1. Agent Bridge orchestrates the workflow and owns authoritative state and every GitHub mutation.
2. Incoming requests, imported issues, and scan findings are inputs, not assumed-complete specifications.
3. The Technical Lead gathers or validates requirements before planning.
4. A multi-issue decomposition is reviewed as one read-only bundle before any issue is created or updated.
5. The Technical Lead designs the implementation and red-test strategy; the Code Worker executes bounded packets.
6. Reusable requirements, test-strategy, TDD, and release-readiness know-how remains canonical in repository skills and is composed explicitly into each relevant prompt mode.
7. The Code Worker performs bounded repository investigation and mutation under mode-specific permissions.
8. Technical Lead implementation and applicable operations review occur after deterministic verification and before documentation authoring.
9. The Documentation Steward keeps every required canonical document aligned with final exact-head code and operations; stale required documentation is never deferred while a delivery is declared ready.
10. Deterministic evidence outranks model claims.
11. Humans retain product decisions, material scope changes, merge authority, destructive actions, deployments, and policy exceptions.

## Roles

### Technical Lead

The Technical Lead is the strongest available read-only reasoning path. It owns requirements discovery, issue authoring and validation, pre-mutation decomposition review, planning, comprehensive red-test design, task decomposition, bounded executor guidance, implementation review, operations assessment, and PR-readiness advice.

It does not edit files, execute unrestricted commands, mutate GitHub, merge, deploy, or approve its own output.

### Code Worker

The Code Worker performs repository scans, focused investigation, TDD implementation, repair, and verification. Agent Bridge selects a read-only or mutating permission profile for each mode.

A scan result is a candidate. The Code Worker cannot promote its own finding into approved implementation work or independently redefine the approved test strategy.

### Documentation Steward

The Documentation Steward assesses documentation impact and updates approved documentation paths only after deterministic verification and accepted Technical Lead review for the same exact code head. It validates that every required document describes the final code, configuration, and operating procedure.

A stale, contradictory, missing, or materially misleading required document is a blocking defect. It must be corrected and revalidated in the same delivery. If correction requires material scope or authority change, the workflow holds for human approval; it does not defer the stale state and claim readiness.

## Common intake lifecycle

```text
Raw input
→ classify feature | defect | refactor
→ gather repository and documentation evidence
→ identify facts, assumptions, conflicts, and unresolved decisions
→ obtain human decisions where required
→ write canonical issue or proposed child-issue bundle
→ validate issue schema and evidence
→ when multiple issues are proposed, run bundle-wide decomposition review
→ Agent Bridge performs approved GitHub issue mutation
→ Technical Lead final validation
→ requirements_ready
```

An apparently complete issue can pass without additional questions, but it never bypasses validation.

## Multi-issue decomposition contract

Before creating or updating multiple child issues:

1. Assemble every proposed issue body without mutating GitHub.
2. Capture one canonical invariant table and current repository/dependency evidence.
3. Run `technical_lead:decomposition_review` over the complete bundle.
4. Record implementation delivery order separately from runtime phase order.
5. Audit current owners and caller paths, lifecycle/state authority, permissions, schema/SQL ownership, GitHub mutation authority, platform desired versus appliance effective authority, compatibility, repair invalidation, and prohibited duplicate abstractions.
6. Repair every missing or conflicting invariant and rerun the review.
7. Allow Agent Bridge issue mutation only after `ready_for_issue_mutation`.

Locally valid individual issues do not compensate for a contradictory bundle.

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

Only `validated_issue` proceeds directly to canonical issue authoring and planning. A split returns to the multi-issue decomposition contract before any child issue mutation.

## Planning contract

The Technical Lead creates the implementation plan only after `requirements_ready`. The plan includes:

- requirement-to-change traceability;
- affected architecture and ownership boundaries;
- a structured target-path inventory;
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

Every target path is classified as exactly one of:

- `existing_at_base`;
- `existing_in_dependency`;
- `proposed_new_production`;
- `proposed_new_test`.

Every target record includes its current or proposed owner and rationale. Dependency-owned paths identify the dependency PR and exact reviewed ref. Proposed production files identify the neighbouring current owner and why no existing file is sufficient. Invalid or unclassified paths block persistence and approval.

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

Plan structural validation and bounded repair remain fail-closed before persistence. Newly generated or repaired plans must use structured target-path provenance. Already-persisted pre-provenance plans retain a narrow compatibility validator for concrete target paths so existing approved work does not regress; all new model output uses the strict validator.

Full planning, red-test repair, and execution-contract repair use separate prompt contracts. Focused repair may replace only the invalid section and the complete plan is revalidated.

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

## Review, operations, documentation, and readiness

The canonical order is:

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

Implementation review checks issue satisfaction, scope, invariants, completion of the approved red-test contract, regression coverage, security, architecture, documentation obligations, and unsupported claims. It does not consume completed documentation.

Operations review activates for deployment, services, configuration, credentials, databases, migrations, queues, rollback, backup, or production verification. It defines prerequisites, steps, abort conditions, rollback, postconditions, and required runbook changes.

Documentation authoring and validation require accepted implementation and applicable operations review for the same `subject_head_sha`. PR readiness requires all required documents to be current or a validated `no_documentation_change` result with rationale and trigger evidence.

A different model from the implementing Code Worker is preferred when available. The workflow records required independence and actual independence separately. Lack of model diversity is reported explicitly and blocks readiness when repository risk policy requires a stronger level.

Every deterministic, review, operations, documentation, and readiness record identifies the exact subject head. Gate status distinguishes:

- `passed`;
- `failed`;
- `not_run`;
- `not_scheduled`;
- `stale`;
- `unknown`.

Only authoritative `passed` evidence for the exact current head satisfies a required gate. A code-changing repair invalidates verification, implementation review, operations review, documentation, and readiness evidence for the previous head. The workflow restarts from deterministic verification.

## Documentation lifecycle

During planning, the Documentation Steward produces a structured impact assessment. After accepted review, it updates or creates every required document using the repository registry in `agentic-maintenance.yaml`.

Required document classes include:

- README and user entry points;
- agent execution policy;
- current and target architecture and data flows;
- prompt and lifecycle-skill contracts;
- architecture decisions;
- configuration reference;
- operations and recovery runbooks;
- testing and verification contracts;
- this maintenance workflow;
- machine-readable document triggers.

A missing, stale, contradictory, or materially misleading required document is a release blocker. It is corrected and revalidated in the same delivery. A later issue, recommended follow-up, archive candidate, or owner assignment does not satisfy readiness.

## Completion evidence

A completed workflow records:

- canonical issue version;
- approved plan and execution contract;
- classified target-path provenance;
- approved red-test specifications and coverage matrices;
- role target and model;
- prompt key/version/source and role-template hash;
- ordered lifecycle skill key/version/content hashes and skill-set hash;
- composed-template and rendered invocation hashes used for each logical call;
- permission profile used by each invocation;
- red and green commit evidence;
- exact-head focused and broad deterministic verification;
- required and actual Technical Lead review independence;
- Technical Lead verdicts bound to the exact head;
- documentation impact, changed documents, and validation;
- operational qualification where applicable;
- unresolved risk and human approvals;
- retrospective result.

## Retrospective

Every non-trivial change ends with a bounded retrospective. Recurring or systemic defects produce the smallest durable prevention: code guard, test, prompt-contract correction, skill update, documentation correction, or proposed `AGENTS.md` rule. One-off preferences do not justify new global rules.
