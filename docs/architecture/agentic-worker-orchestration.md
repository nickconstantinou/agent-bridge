# Role-Based Agentic Worker Orchestration

## Status

Canonical target-state architecture. This document describes the Engineering Worker after role-based orchestration is implemented.

## Purpose

The Engineering Worker converts incomplete intent, imported GitHub issues, and repository scan findings into validated engineering work, implementation plans, tested pull requests, and current documentation.

Agent Bridge remains the authoritative orchestrator. Models provide bounded reasoning or execution inside Bridge-owned lifecycle, permission, validation, retry, budget, exact-head, issue-mutation, and approval controls.

## Configurable roles

The platform exposes three workspace roles:

| Role | Responsibility | Default authority |
|---|---|---|
| Technical Lead | Requirements discovery, canonical issue creation and validation, cross-issue decomposition review, implementation planning, task decomposition, executor guidance, implementation review, operations assessment, and PR readiness | Read-only evidence tools |
| Code Worker | Defect and refactor scanning, repository investigation, TDD implementation, repair, and deterministic verification | Permission varies by workflow mode |
| Documentation Steward | Documentation impact assessment and creation, update, and validation of README, architecture, operations, configuration, testing, and maintenance documentation | Documentation-only mutation |

A role is independent of provider authentication. A role assignment binds:

- an authenticated CLI;
- an explicit model;
- ordered fallbacks;
- a permission profile;
- budgets and timeouts;
- structured input and output contracts.

## Role modes

### Technical Lead modes

- `requirements`: gather facts, identify assumptions, and expose product decisions;
- `issue_validation`: validate an apparently complete issue against repository evidence;
- `issue_authoring`: create the canonical issue contract;
- `decomposition_review`: audit a complete proposed child-issue bundle against one invariant table before any GitHub issue mutation;
- `planning`: create the implementation plan, target-path provenance, and execution contract;
- `executor_guidance`: assess bounded evidence from a blocked or incomplete worker pass;
- `implementation_review`: compare exact-head changes with requirements, invariants, and deterministic evidence before documentation;
- `operations_review`: define exact-head rollout, rollback, migration, and operational evidence before documentation;
- `pr_readiness`: produce the final advisory verdict after deterministic, review, operations, and documentation gates.

The Technical Lead owns independent review and operations reasoning through the read-only AdvisorService path. Independence is based on separation from the mutating Code Worker: the Technical Lead did not author or modify the implementation, has no mutation authority in the review invocation, and performs a fresh review of the exact checked head. The same frontier model or CLI may be used. Provider/model diversity is useful metadata but is not a blocking requirement, and prior read-only Technical Lead planning or advice does not disqualify the reviewer.

### Code Worker modes

- `scan`: read-only defect or refactor discovery;
- `investigate`: read-only evidence gathering for a specific candidate or issue;
- `red`: test-only mutation and verified failing test;
- `green`: production implementation without modifying the committed red tests;
- `repair`: bounded correction in response to deterministic or Technical Lead evidence;
- `verify`: permitted commands and evidence collection without scope expansion.

The same CLI and model may perform every mode, but Agent Bridge applies a distinct permission profile to each invocation.

### Documentation Steward modes

- `impact`: read-only documentation impact assessment during planning;
- `author`: documentation-only mutation after deterministic verification and accepted Technical Lead review for the same exact head;
- `validate`: compare all required documentation with the final exact-head code, review, and operational evidence;
- `maintenance`: identify and require correction of missing, stale, contradictory, or misleading canonical repository documents.

The Documentation Steward may not change production code. A required code correction returns to the Code Worker and invalidates prior review, documentation, and readiness evidence for that code head.

## Change workflows

### Feature workflow

```text
Raw request or imported feature issue
→ Technical Lead requirements discovery or validation
→ canonical feature issue
→ implementation plan and documentation impact
→ approval when policy requires it
→ Code Worker red/green implementation
→ deterministic verification
→ Technical Lead implementation review
→ Technical Lead operations review when triggered
→ Documentation Steward authoring and validation
→ Technical Lead PR readiness
→ exact-head CI
→ fresh exact-head Technical Lead final review
→ human merge gate
```

### Defect workflow

```text
Code Worker read-only scan or reported defect
→ candidate finding with evidence
→ Technical Lead validate, reject, combine, split, or request evidence
→ canonical defect issue
→ regression-first implementation plan
→ Code Worker red/green repair
→ deterministic verification
→ Technical Lead implementation review
→ Technical Lead operations review when triggered
→ Documentation Steward authoring and validation when required
→ Technical Lead PR readiness
→ exact-head CI
→ fresh exact-head Technical Lead final review
→ human merge gate
```

A scan finding is never implementation-ready by itself.

### Refactor workflow

```text
Code Worker read-only refactor scan or maintainer request
→ candidate with maintainability evidence and invariants
→ Technical Lead validates value and scope
→ canonical refactor issue
→ behaviour-preserving implementation plan
→ Code Worker characterization/red/green work
→ deterministic verification
→ Technical Lead implementation review
→ Technical Lead operations review when triggered
→ Documentation Steward architecture and maintenance authoring and validation
→ Technical Lead PR readiness
→ exact-head CI
→ fresh exact-head Technical Lead final review
→ human merge gate
```

A refactor must have concrete evidence and measurable benefit. Consistency or cleanliness alone is insufficient.

## Canonical issue contract

Every issue contains:

- problem or opportunity;
- desired outcome;
- current and required behaviour;
- scope and explicit non-goals;
- constraints and invariants;
- acceptance criteria;
- authoritative evidence;
- documentation impact;
- operational impact;
- security and data impact;
- rollout and compatibility;
- unresolved decisions.

Type-specific requirements are defined in `docs/agentic-maintenance.md`.

No implementation plan is created until the issue is `requirements_ready`.

## Requirements validation

Even a detailed GitHub or local issue passes through Technical Lead validation. The validation result is structured:

```json
{
  "verdict": "ready | revise | clarify | split | reject",
  "change_type": "feature | defect | refactor",
  "missing_facts": [],
  "unresolved_product_decisions": [],
  "unsupported_assumptions": [],
  "conflicting_requirements": [],
  "recommended_issue_changes": [],
  "evidence_reviewed": []
}
```

Repository facts are gathered through typed, allowlisted, read-only Bridge tools. Product choices are surfaced to a human and are never silently invented.

When validation or authoring produces multiple child issues, Agent Bridge assembles every proposed issue body without mutation and invokes `technical_lead:decomposition_review`. The bundle review separates implementation delivery order from runtime phase order and checks one canonical invariant table covering owners/callers, lifecycle/state authority, permissions, schema/SQL ownership, GitHub authority, platform/appliance authority, compatibility, repair invalidation, and prohibited duplicate abstractions. GitHub issue mutation is blocked until the complete bundle is consistent.

## Implementation planning

Every target production or test path is classified as `existing_at_base`, `existing_in_dependency`, `proposed_new_production`, or `proposed_new_test`. Dependency paths identify the dependency PR and exact reviewed ref. Proposed production files identify their neighbouring owner and why no current file is sufficient. Invalid or unclassified paths block plan approval.

## Role assignment and model selection

The hosted platform and OSS configuration persist explicit role targets rather than relying on one global worker chain.

For each role, the user may choose:

- `automatic`: Agent Bridge ranks authenticated targets by role capability;
- `recommended`: Agent Bridge proposes a mapping for approval;
- `manual`: the user selects every CLI, model, and fallback.

When only one CLI is authenticated, Agent Bridge still resolves a model separately for each role. When only one model is available, role separation, prompts, sessions, permissions, budgets, and audit remain distinct. The workspace reports model diversity as unavailable while retaining independent Technical Lead review through the read-only role boundary.

The configured Technical Lead advisor target owns final review. Agent Bridge may prefer a different CLI or model when available as an extra challenge signal, but the independence gate requires only:

1. Technical Lead reviewer role;
2. no authorship or modification of the reviewed implementation;
3. no mutation authority in the review invocation;
4. a fresh review bound to the exact checked `subject_head_sha`.

Prior read-only Technical Lead requirements, planning, decomposition, guidance, implementation review, or operations review does not disqualify the final reviewer. The Code Worker cannot review its own mutation. A head change requires a fresh Technical Lead invocation, not a different model or an endlessly new reviewer identity.

## Authority boundaries

Agent Bridge owns:

- workflow classification and transitions;
- authoritative state and leases;
- role resolution and fallback;
- permission profiles and capability tokens;
- context selection, redaction, and budgets;
- structured-output validation and repair limits;
- GitHub issue and PR mutation;
- deterministic tests and exact-head evidence gates;
- approvals, merge, deployment, and destructive-operation policy;
- audit and restart recovery.

Models cannot grant themselves tools, change role, expand scope, approve their own work, mutate GitHub, merge, deploy, or bypass deterministic or human gates.

## Exact-head evidence and repair invalidation

Verification, implementation review, operations review, documentation authoring/validation, PR readiness, exact-head CI, and final Technical Lead review record the same `subject_head_sha`.

Required gate states distinguish:

- `passed`;
- `failed`;
- `not_run`;
- `not_scheduled`;
- `stale`;
- `unknown`.

Only authoritative `passed` evidence for the exact current head satisfies a required gate. A code-changing repair invalidates all verification, review, operations, documentation, readiness, CI, and final-review evidence for the previous head. The workflow returns to deterministic verification and proceeds through the canonical order again.

## Documentation contract

The repository document registry is `agentic-maintenance.yaml`. The Documentation Steward uses it to determine which canonical documents are required for each change trigger.

A PR cannot become ready until every required document is current or a validated `no_documentation_change` decision is recorded. A missing, stale, contradictory, or materially misleading required document is a blocker and must be corrected and revalidated in the same delivery. It cannot be deferred to a later issue while the current delivery is declared ready.

When the required documentation correction would materially change approved product, architecture, authority, or scope, the workflow holds for human scope approval. That hold is not a deferral and cannot receive a ready verdict.

## Degraded operation

A workspace remains usable with one authenticated CLI or model. The effective status records:

- role separation;
- target and fallback selected for each role;
- model diversity availability;
- Technical Lead review-role availability;
- unavailable role capabilities;
- any repository policy that blocks degraded execution.

Model diversity degradation is explicit and audited, but it is not presented as loss of review independence when the Technical Lead role and authority boundary remain intact.

## Non-goals

- no unrestricted autonomous multi-agent conversation loop;
- no direct provider-native tool grants outside Bridge policy;
- no model-owned workflow state;
- no requirement that every role use a different provider or model;
- no automatic merge, production mutation, or destructive action;
- no assumption that incoming issues or scan findings are complete;
- no deferred stale required documentation while a delivery is represented as ready.
