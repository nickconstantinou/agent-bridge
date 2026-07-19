# Engineering Worker — User and Operator Guide

The worker turns feature requests, defect reports, refactor opportunities, imported GitHub issues, and repository scans into validated issues, implementation plans, tested draft pull requests, and current documentation.

Agent Bridge orchestrates the work. It assigns authenticated CLIs and models to three roles while retaining authoritative state, prompt selection, permissions, deterministic gates, and human approvals.

## The three roles

| Role | What it does |
|---|---|
| Technical Lead | Gathers or validates requirements, writes canonical issues and plans, guides bounded retries, reviews implementation and operations, and advises PR readiness using read-only evidence |
| Code Worker | Scans and investigates repositories read-only, then performs approved TDD implementation, repair, and verification in disposable workspaces |
| Documentation Steward | Assesses documentation impact and updates or validates approved documentation paths after implementation evidence is available |

Scanner is a Code Worker mode. Independent review and operations are Technical Lead modes, not separate configurable roles.

## The invariant

Nothing merges, deploys, changes secrets or permissions, or performs a destructive operation without the existing explicit human gate.

Models do not own workflow state, role selection, prompts, validators, permissions, or approval. Agent Bridge owns those boundaries.

## Workflow at a glance

```text
Feature request, defect/refactor report, imported issue, or scan finding
→ requirements discovery or validation
→ canonical issue
→ requirements_ready
→ Technical Lead implementation plan and comprehensive red-test contract
→ documentation impact
→ approval when required
→ Code Worker implements approved red tests and the green change
→ deterministic verification
→ Technical Lead implementation and operations review
→ Documentation Steward updates and validation
→ PR readiness
→ draft PR and CI
→ human merge approval
```

A detailed issue can pass validation without extra questions, but it never bypasses validation. A scan finding is only a candidate until the Technical Lead accepts, rejects, combines, splits, or requests more evidence.

## Change paths

### Features

The worker establishes the user problem, desired outcome, use cases, required and failure behaviour, constraints, non-goals, acceptance criteria, compatibility, rollout, and documentation/operational impact before planning.

### Defects

The worker records observed and expected behaviour, reproduction or authoritative evidence, severity and blast radius, facts versus hypotheses, regression-test requirements, and safe-resolution criteria.

### Refactors

The worker requires concrete maintainability or architectural evidence, behavioural invariants, measurable benefit, characterization strategy, and explicit non-goals. Cleanliness or consistency alone is not enough.

Full issue contracts: `docs/agentic-maintenance.md`.

## Commands

Existing commands remain the user entry points:

| Command | What it does |
|---|---|
| `/review [repo]` | Queue a read-only Code Worker defect scan. Findings remain candidates. |
| `/feature <brief>` | Start feature requirements intake. Bare `/feature` captures the next message. |
| `/issues` | List candidate, requirements, approved, and held work items with available actions. |
| `/issue <id>` | Show one work item, validation status, decisions, plan, and linked GitHub state. |
| `/jobs` | List active, pending, blocked, and resumable jobs. |
| `/job <id>` | Show phase, owner, lease, role target, prompt contract, attempts, evidence, and errors. |
| `/approvals` | Re-list pending human decisions, merge approvals, and policy exceptions. |
| `/models` | Show models exposed by the active interactive CLI. |
| `/chain` | Show legacy chain compatibility plus effective role targets. |
| `/effort` | Show or change interactive effort; role jobs use role/model policy. |
| `/cli` | Show or change the interactive CLI. |

Role assignment may also be managed through the hosted platform or the OSS configuration/status surface.

## Typical feature session

1. Send `/feature <brief>` or import a GitHub issue.
2. The Technical Lead reads bounded repository and documentation evidence.
3. If the issue is clear, it is validated without unnecessary questions. If a product decision is missing, the item pauses for your answer.
4. The worker records a canonical issue and marks it `requirements_ready`.
5. The Technical Lead creates a repository-grounded plan, bounded Code Worker packets, execution contract, risks, verification, documentation obligations, and comprehensive red-test specifications.
6. The plan validator rejects generic instructions such as `write tests`; each red test identifies product and architectural intent, production boundary, fixture, real caller action, expected result, current failure, focused command, authoritative oracle, false-positive controls, and sibling behaviour remaining green.
7. After required approval, the Code Worker creates a disposable workspace and implements the exact approved red-test packet before the green change.
8. Deterministic verification runs before model review.
9. The Technical Lead reviews requirement satisfaction, test-contract completion, and operational impact.
10. The Documentation Steward updates required documents under a documentation-only path policy.
11. A draft PR opens and the existing CI/head-SHA merge gate requests approval.

## Typical scan session

1. Send `/review <repo>` or trigger an approved refactor scan.
2. The Code Worker scans under read-only permissions.
3. Candidate findings include evidence, affected boundaries, confidence, and required next evidence.
4. The Technical Lead returns one disposition: validated issue, needs more evidence, needs a human decision, duplicate/superseded, not justified, or split.
5. Only a validated canonical issue can proceed to planning and implementation.

## Role assignment

Each role binds:

- authenticated CLI;
- explicit model;
- ordered fallbacks;
- permission profile;
- call/time budget;
- prompt and structured-output contracts.

Assignment modes:

- **Automatic:** Agent Bridge selects suitable authenticated targets.
- **Recommended:** Agent Bridge proposes assignments for approval.
- **Manual:** the user selects every primary and fallback CLI/model.

Detailed configuration: `docs/configuration/agent-role-assignment.md`.

### One authenticated CLI

One CLI is sufficient. Agent Bridge selects a model separately for the Technical Lead, Code Worker, and Documentation Steward when the CLI exposes multiple models.

### One available model

One model can serve every role using separate sessions, prompts, validators, permissions, budgets, and audit. Status reports:

```text
Role separation: preserved
Model diversity: unavailable
Independent-model review: unavailable
```

Work continues unless repository policy requires model-independent review for the detected risk.

## Prompt contracts

Prompts are separate by role, mode, and repair purpose. The Technical Lead planning prompt is not reused for requirements, review, operations, code execution, or documentation. Focused red-test repair and execution-contract repair use distinct keys.

Agent Bridge selects the prompt contract and separately enforces:

- role and mode;
- typed input/output schemas;
- validator;
- evidence/tool grants;
- permission profile;
- logical-call and repair budgets;
- lifecycle ownership.

Canonical role prompts are registered in `src/agenticPromptContracts.ts` and stored as reviewed Markdown files under `prompts/worker/roles/`. Each contract has a version and effective content hash. Fallback models receive the same prompt contract; only the CLI/model target changes.

Canonical role prompts do **not** support database overrides.

### Why the SQLite prompt table is not a backup

The source-controlled Markdown file is already the built-in fallback when no database row exists. A database row replaces that reviewed file at runtime, so it is an **override**, not a backup.

That distinction matters because an override can change requirements, planning, tests, code-execution instructions, review, or operations without:

- a reviewed Git diff;
- contract versioning;
- deterministic tests;
- exact-head CI;
- reproducible rollout across workspaces;
- a known application-SHA rollback.

The target architecture therefore removes database override capability for canonical role prompts.

### Why the table is not dropped in this PR

The existing table remains temporarily because:

- current production rows have not been inventoried;
- some legacy handlers still read those rows;
- deleting a row or table could silently change existing workspace behaviour;
- schema changes and production database mutations use the separately guarded migration process.

Retirement is staged:

1. inventory legacy rows by workspace and key without logging contents;
2. give every non-empty row an explicit migrate, intentionally discard, or hold-for-human decision;
3. move approved custom behaviour into reviewed prompt files and tests;
4. disable reads handler by handler during role migration;
5. remove legacy write/read methods after callers are gone;
6. drop the table through a separately approved backup/rollback-qualified migration.

No new role prompt, operator workflow, or platform setting may create a database override. Existing legacy prompt keys remain compatibility aliases only while their handlers are migrated.

Canonical prompt design: `docs/architecture/agentic-prompt-contracts.md`.

## Permission behaviour

### Technical Lead

Read-only typed evidence tools. No file mutation, unrestricted shell, GitHub mutation, service control, merge, deploy, rollback, or approval.

### Code Worker

- scan/investigate: read-only;
- red: test-only mutation implementing the approved red-test specification and expected failing assertion;
- green: production mutation without changing committed red tests;
- repair: bounded to the approved packet;
- verify: approved commands and evidence without new changes.

### Documentation Steward

- impact/validate: read-only;
- author/maintenance: paths allowed by `agentic-maintenance.yaml` only.

Production or test-code changes requested by the Documentation Steward return to the Code Worker.

## Configuration and status

Role configuration is authoritative once persisted. Legacy `WORKER_CODE_CLI_CHAIN` and `WORKER_SCRIBE_CLI_CHAIN` remain migration/compatibility inputs only.

The effective status shows:

- requested and effective CLI/model per role;
- fallbacks and configuration source;
- authentication and model probe state;
- prompt key/version/source/hash;
- permission profile;
- logical-call and timeout budgets;
- model-diversity and review-independence state;
- legacy compatibility state;
- active workflow phase and owner.

Status and probes are read-only. Reconciliation is a separate explicit action.

## Failure and recovery

- Structured issue, plan, red-test, review, and documentation output is validated before persistence.
- A plan that says only `write tests` or omits product/architectural intent fails validation.
- An otherwise valid plan with only an inadequate red-test contract may receive one focused red-test repair; execution-contract repair remains separate.
- Required malformed output receives only the configured bounded repair and otherwise fails closed.
- Failed executor work remains bounded; no open-ended model loop is allowed.
- Cancellation prevents new role calls and fences late output.
- Lost leases and stale workers cannot persist or dispatch duplicate calls.
- Restart resumes from authoritative durable phase state and preserves budgets and prompt contract identity.
- Completed phases are not repeated.
- Missing role capability produces an explicit blocked/degraded state.
- Existing workspace cleanup, supervisor, head-SHA, CI, and merge protections remain active.

Operations and rollback: `docs/operations/agentic-worker-runbook.md`.

## Documentation readiness

`agentic-maintenance.yaml` lists canonical documents and deterministic change triggers. A PR cannot become ready until required documents are current or a validated `no_documentation_change` result records rationale and trigger evaluation.

## Troubleshooting

### Work never reaches planning

Inspect `/issue <id>` for missing facts, unresolved decisions, validation errors, or the `requirements_ready` state. A product decision requires human input; repository facts should be gathered by the Technical Lead.

### Plan rejected for red-test quality

Inspect typed validation errors. Every acceptance criterion and affected architectural/risk boundary must be covered. Focused red-test repair is allowed only when the rest of the plan is valid.

### Prompt-table migration reports an unexpected row

Do not restart services or bypass the migration. Schema migration 2 fails closed and preserves schema version 1 plus the table contents. Since production rows are expected to be absent, treat this as configuration drift: inspect it through the guarded database process without logging prompt text, resolve the discrepancy explicitly, then rerun the migration. Runtime code has no prompt-table reader or writer.

### Scan produced no implementation job

This is expected until the Technical Lead validates the finding.

### Role unavailable

Check effective role status, CLI authentication, model probe freshness, capability compatibility, fallbacks, and repository policy.

### Review is marked non-independent

Only one suitable target was available. Role separation remains active, but the same target reviewed in an isolated session. Add another suitable target when policy requires independence.

### Documentation blocks readiness

Inspect documentation impact and manifest trigger evaluation. Configure a fallback or update required documents through the documentation-only lane.

### Job stuck or restarted

Use `/job <id>` to inspect authoritative owner, lease, role attempt, prompt contract, and phase. Do not manually force status.

### Lost approval controls

Use `/approvals`; the approval remains pending while blocking evidence is unresolved.

## What the worker will not do

- assume a brief, imported issue, or scan finding is complete;
- plan before validated requirements;
- accept vague test instructions instead of a comprehensive red-test contract;
- let a scan agent approve its own finding;
- let prompts or models expand permissions or scope;
- load canonical role prompts from mutable database text;
- mutate live checkouts for implementation;
- weaken red/green separation;
- claim readiness over failed deterministic evidence;
- present same-model review as independent;
- bypass documentation obligations;
- merge, deploy, or perform destructive operations without the required human gate.

## Canonical references

- Architecture: `docs/architecture/engineering-worker.md`
- Role orchestration: `docs/architecture/agentic-worker-orchestration.md`
- Prompt contracts: `docs/architecture/agentic-prompt-contracts.md`
- Maintenance workflow: `docs/agentic-maintenance.md`
- Configuration: `docs/configuration/agent-role-assignment.md`
- Operations: `docs/operations/agentic-worker-runbook.md`
- Testing: `docs/testing/agentic-worker-verification.md`
- Decision: `docs/adr/ADR-005-role-based-agentic-orchestration.md`
- Epic plan: `docs/implementation-plans/issue-159-role-based-orchestration.md`
- Prompt/red-test addendum: `docs/implementation-plans/issue-159-prompt-and-red-test-contract.md`
- Document registry: `agentic-maintenance.yaml`