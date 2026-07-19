# Role-Based Agentic Worker Orchestration

## Status

Canonical target-state architecture. This document describes the Engineering Worker after role-based orchestration is implemented.

## Purpose

The Engineering Worker converts incomplete intent, imported GitHub issues, and repository scan findings into validated engineering work, implementation plans, tested pull requests, and current documentation.

Agent Bridge remains the authoritative orchestrator. Models provide bounded reasoning or execution inside Bridge-owned lifecycle, permission, validation, retry, budget, and approval controls.

## Configurable roles

The platform exposes three workspace roles:

| Role | Responsibility | Default authority |
|---|---|---|
| Technical Lead | Requirements discovery, canonical issue creation and validation, implementation planning, task decomposition, executor guidance, implementation review, operations assessment, and PR readiness | Read-only evidence tools |
| Code Worker | Defect and refactor scanning, repository investigation, TDD implementation, repair, and deterministic verification | Permission varies by workflow mode |
| Documentation Steward | Documentation impact assessment and creation or update of README, architecture, operations, configuration, testing, and maintenance documentation | Documentation-only mutation |

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
- `planning`: create the implementation plan and execution contract;
- `executor_guidance`: assess bounded evidence from a blocked or incomplete worker pass;
- `implementation_review`: compare final changes with requirements, invariants, and evidence;
- `operations_review`: define rollout, rollback, migration, and operational evidence;
- `pr_readiness`: produce the final advisory verdict after deterministic gates.

The Technical Lead owns independent review and operations reasoning. Agent Bridge prefers a model different from the implementing Code Worker when available, but does not expose separate user-configurable reviewer or operations roles.

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
- `author`: documentation-only mutation after implementation facts are available;
- `validate`: compare documentation with the final code and operational evidence;
- `maintenance`: identify missing or stale canonical repository documents.

The Documentation Steward may not change production code. A required code correction returns to the Code Worker.

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
→ Technical Lead implementation and operations review
→ Documentation Steward updates
→ documentation validation
→ PR readiness and human merge gate
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
→ Technical Lead review
→ Documentation Steward updates when behaviour or operations changed
→ PR readiness and human merge gate
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
→ Technical Lead invariant review
→ Documentation Steward architecture and maintenance updates
→ PR readiness and human merge gate
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

## Role assignment and model selection

The hosted platform and OSS configuration persist explicit role targets rather than relying on one global worker chain.

For each role, the user may choose:

- `automatic`: Agent Bridge ranks authenticated targets by role capability;
- `recommended`: Agent Bridge proposes a mapping for approval;
- `manual`: the user selects every CLI, model, and fallback.

When only one CLI is authenticated, Agent Bridge still resolves a model separately for each role. When only one model is available, role separation, prompts, sessions, permissions, budgets, and audit remain distinct, while the workspace reports that model diversity and independent-model review are unavailable.

Review target preference is:

1. a different CLI and model from the implementing worker;
2. a different model on the same CLI;
3. the Technical Lead model in a fresh isolated session;
4. the same target, explicitly marked non-independent.

## Authority boundaries

Agent Bridge owns:

- workflow classification and transitions;
- authoritative state and leases;
- role resolution and fallback;
- permission profiles and capability tokens;
- context selection, redaction, and budgets;
- structured-output validation and repair limits;
- deterministic tests and evidence gates;
- approvals, merge, deployment, and destructive-operation policy;
- audit and restart recovery.

Models cannot grant themselves tools, change role, expand scope, approve their own work, merge, deploy, or bypass deterministic or human gates.

## Documentation contract

The repository document registry is `agentic-maintenance.yaml`. The Documentation Steward uses it to determine which canonical documents are required for each change trigger.

A PR cannot become ready until required documents are current or a validated `no_documentation_change` decision is recorded.

## Degraded operation

A workspace remains usable with one authenticated CLI or model. The effective status records:

- role separation;
- target and fallback selected for each role;
- model diversity availability;
- independent-model review availability;
- unavailable role capabilities;
- any repository policy that blocks degraded execution.

Degradation is explicit and audited; it is not silently presented as independent review.

## Non-goals

- no unrestricted autonomous multi-agent conversation loop;
- no direct provider-native tool grants outside Bridge policy;
- no model-owned workflow state;
- no requirement that every role use a different provider;
- no automatic merge, production mutation, or destructive action;
- no assumption that incoming issues or scan findings are complete.