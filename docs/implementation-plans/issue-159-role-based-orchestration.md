# Implementation Plan — Issue #159 Role-Based Agentic Orchestration

## Status

Approved implementation handoff for a coding agent. The target-state documentation in this branch is normative and describes the expected completed behaviour.

## Objective

Implement three configurable Engineering Worker roles—Technical Lead, Code Worker, and Documentation Steward—and route feature, defect, and refactor workflows through requirements validation, advisor-authored plans, bounded worker execution, documentation maintenance, deterministic verification, and existing human gates.

Agent Bridge remains authoritative for workflow state, role resolution, permissions, evidence, budgets, retries, cancellation, approvals, merge, deployment, and audit.

## Read first

- Issue #159;
- `AGENTS.md`;
- `docs/agentic-maintenance.md`;
- `docs/architecture/engineering-worker.md`;
- `docs/architecture/agentic-worker-orchestration.md`;
- `docs/configuration/agent-role-assignment.md`;
- `docs/operations/agentic-worker-runbook.md`;
- `docs/testing/agentic-worker-verification.md`;
- `docs/decisions/ADR-009-role-based-agentic-orchestration.md`;
- `agentic-maintenance.yaml`;
- Issues #100, #119, #132, and #146;
- PR #157 and the current implementation-plan validation path.

Use the repository requirements, risk-test, TDD, release-readiness, and git-sandbox skills before editing.

## Non-negotiable invariants

1. Exactly three user-configurable roles.
2. Scanner is a Code Worker mode; reviewer and operations are Technical Lead modes.
3. Role authority is independent of CLI/provider identity.
4. Technical Lead remains mutation-free and uses the authoritative advisor boundary.
5. Code Worker permissions are mode-specific and Bridge-enforced.
6. Documentation Steward authoring is documentation-path-only.
7. No planning before `requirements_ready`.
8. No scan finding becomes implementation work without Technical Lead disposition.
9. Structured issue, plan, guidance, review, and documentation outputs are validated before persistence.
10. Deterministic evidence and human gates cannot be overridden by model output.
11. Cancellation, lease loss, restart, and retries cannot duplicate logical calls or overwrite terminal state.
12. Existing red/green commit separation, disposable workspaces, PR head checks, CI gates, and merge approval remain intact.
13. Legacy chain support is explicit compatibility behaviour, not a silent alternate authority.

## Delivery strategy

Implement as reviewable slices. Do not attempt a broad worker rewrite. Reuse the current handler map, repositories, AdvisorService, provider registry, workspaces, execution supervisor, prompt registry, implementation-plan validator, and lifecycle work from Issue #119.

Every behaviour slice follows:

1. failing acceptance or boundary test committed alone;
2. minimal implementation committed separately;
3. focused verification;
4. full relevant suite and architectural checks;
5. retrospective before moving to the next slice.

## Phase 0 — Reconcile current code and active work

### Investigation

Map current code at the exact implementation base:

- worker configuration loading and env compatibility;
- provider/model registry and authentication status;
- advisor configuration, trusted request path, tools, audit, budgets, and output schemas;
- `feature_plan`, `defect_scan`, `refactor_scan`, `implementation_plan`, `orchestrated_task`, `tdd_implementation`, and `pr_lifecycle` handlers;
- prompt keys and dynamic DB prompt overrides;
- work item/job schema, repositories, phase state, leases, cancellation, and restart recovery;
- documentation and PR prose generation;
- platform workspace configuration APIs and UI in `agent-bridge-platform`.

Review open or merged work that may change these boundaries, especially PR #157 and Issues #100, #119, #132, and #146. Update this plan's target-file list before implementation if ownership has moved.

### Output

Commit no production changes. Record a current-state mapping in the PR description or implementation evidence, including authoritative owners and any revised file names.

## Phase 1 — Domain contracts and persisted role assignments

### Tests first

Add acceptance tests proving:

- the public role ID set is exactly `technical_lead`, `code_worker`, `documentation_steward`;
- scanner/reviewer/operations cannot be persisted as standalone roles;
- assignments require explicit CLI and model once resolved;
- assignment mode accepts only automatic, recommended, or manual;
- fallbacks are ordered and deduplicated;
- permission profiles are role/mode compatible;
- role status does not expose secrets;
- legacy chains do not override explicit persisted assignments.

### Implementation

Introduce central domain types, likely under a worker/shared policy module rather than handlers:

```ts
type AgentRole = "technical_lead" | "code_worker" | "documentation_steward";
type TechnicalLeadMode =
  | "requirements"
  | "issue_validation"
  | "issue_authoring"
  | "planning"
  | "executor_guidance"
  | "implementation_review"
  | "operations_review"
  | "pr_readiness";
type CodeWorkerMode = "scan" | "investigate" | "red" | "green" | "repair" | "verify";
type DocumentationStewardMode = "impact" | "author" | "validate" | "maintenance";
type AssignmentMode = "automatic" | "recommended" | "manual";
```

Persist:

- workspace/repository scope;
- role;
- assignment mode;
- primary provider/CLI and model;
- ordered fallbacks;
- role budget/timeout policy;
- review preference;
- effective resolution and degradation metadata;
- timestamps and configuration source.

Use a dedicated repository for new SQL. Keep migrations additive and idempotent. Coordinate schema/lifecycle ownership with Issues #119 and #135; do not add direct SQL outside the owning repository.

### Likely files

Resolve exact names during Phase 0. Expected areas:

- `src/config.ts` and worker config parsing;
- `src/providers/*` capability metadata;
- `src/repositories/*` and `src/db/migrations/*`;
- worker status projections;
- architecture lint ownership rules;
- database and config tests.

## Phase 2 — Authenticated CLI and model capability discovery

### Tests first

Cover:

- provider-native model discovery where supported;
- static capability registry fallback;
- manually entered model IDs requiring validation;
- bounded non-mutating model probes;
- stale, failed, unavailable, and authenticated states;
- capability ranking per role;
- one CLI exposing different models to different roles;
- one model serving all roles with explicit degradation;
- invalid structured-output or read-only capability preventing Technical Lead selection.

### Implementation

Extend provider adapters or the capability registry with target metadata:

- provider/CLI ID;
- model ID and display name;
- authentication source and authoritative status;
- reasoning, coding, documentation, context, cost, and latency tiers;
- structured-output verification;
- enforceable read-only behaviour;
- probe timestamp and result.

Add a role resolver that consumes authenticated targets and workspace policy and returns:

- effective primary;
- effective fallbacks;
- resolution reason;
- missing capabilities;
- model diversity state;
- independent-review state;
- whether policy permits execution.

Do not embed vendor-specific selection logic in worker handlers.

## Phase 3 — Mode-specific permission profiles

### Tests first

Prove:

- Technical Lead modes cannot mutate repository, Git, GitHub, services, database, or production state;
- Code Worker scan/investigate is read-only;
- red mode is test-only and must demonstrate expected failure;
- green mode cannot modify committed red tests;
- repair is confined to the approved work packet;
- verify cannot introduce new changes;
- Documentation Steward author mode can mutate only paths allowed by `agentic-maintenance.yaml`;
- capability tokens are invocation-scoped and revoked on completion, timeout, cancellation, or lease loss;
- nested child processes do not receive broader credentials.

### Implementation

Create a central role-mode-to-permission resolver. Reuse existing capability-token and child-environment hardening. Permission is selected by Agent Bridge immediately before dispatch; the model cannot request or elevate it.

For documentation authoring, parse the repository manifest deterministically and use exact-path/glob rules with deny precedence. Reject production/test/script/config mutation outside the documented allowlist.

Add Architecture Lint checks preventing bypasses and direct role-provider invocation from handlers.

## Phase 4 — Canonical requirements and issue contracts

### Tests first

Create separate feature, defect, and refactor fixtures covering ready, revise, clarify, split, reject, and malformed responses.

Prove:

- every input passes Technical Lead validation;
- a detailed issue can pass without unnecessary human questions;
- repository facts are gathered through read-only tools;
- product decisions pause for human input;
- no plan queues before `requirements_ready`;
- feature/defect/refactor required sections differ correctly;
- facts and hypotheses are separated for defects;
- refactors without evidence or measurable benefit are rejected;
- canonical issue versions and evidence references are durable;
- restart does not duplicate validation or lose a human-decision pause.

### Implementation

Add structured contracts and validators for:

- common issue fields;
- feature-specific fields;
- defect-specific evidence/reproduction/severity/regression fields;
- refactor-specific evidence/invariants/benefit/characterization fields;
- validation verdict;
- candidate-finding disposition.

Add durable work-item states including at least:

```text
intake
requirements_gathering
human_decision_required
requirements_ready
planning
```

Preserve externally authored GitHub issue content and record the canonical validated version separately or update GitHub through an explicit Bridge-owned mutation after approval. Do not let the Technical Lead call GitHub directly.

## Phase 5 — Bounded Technical Lead evidence tools

### Dependency

Reuse or complete Issue #100/#146 typed evidence infrastructure. Do not create a second advisor service.

### Tests first

Cover:

- repository listing and bounded file reads inside the canonical worktree;
- Git status/diff/history evidence through typed commands;
- canonical documentation and manifest reads;
- issue/work-item/job/verification evidence;
- size, file-count, path, time, and total-context limits;
- freshness and authority metadata;
- no unrestricted shell or provider-native tools;
- cancellation and lease fencing during tool use;
- audit without secrets or raw unrestricted context.

### Implementation

Define tool grants by Technical Lead mode. Requirements and planning may inspect current repository/docs; implementation review receives final diff and deterministic evidence; operations review receives only approved operational evidence.

Evidence records include source, authority, captured timestamp, scope, truncation, and freshness. The Technical Lead cannot claim high confidence when evidence is absent or stale.

## Phase 6 — Technical Lead issue authoring and advisor-authored planning

### Tests first

Prove:

- canonical issues are authored only after validation inputs are complete;
- planning requires `requirements_ready`;
- the existing AdvisorService is the only Technical Lead execution boundary;
- plans trace each acceptance criterion;
- plans contain bounded Code Worker packets, red/green phases, verification, documentation, operations, rollback, and escalation conditions;
- the execution contract is structurally validated;
- malformed output gets at most the configured bounded repair and is revalidated;
- required output failure is fail-closed;
- legacy scribe fallback is explicit, audited, and marked degraded;
- PR #157's contract validator remains effective until the canonical path fully replaces it.

### Implementation

Add Technical Lead prompt/contracts for:

- requirements analysis;
- issue validation;
- issue authoring;
- implementation planning;
- plan repair;
- executor guidance;
- implementation review;
- operations review;
- PR readiness.

Replace `WORKER_SCRIBE_CLI_CHAIN` as the canonical implementation-plan author. Keep existing prompt override behaviour only where it can be made role/mode aware and structurally validated.

Persist role, mode, target, model, attempt, fallback, outcome, budget, and selected bounded result. Do not persist secrets or unrestricted transcripts.

## Phase 7 — Code Worker scan and execution packets

### Tests first

Cover:

- defect and refactor scans execute under read-only Code Worker mode;
- findings are candidate records, not approved issues;
- Technical Lead dispositions queue the correct next state;
- split findings create distinct candidate/canonical items without duplication;
- approved plans produce bounded packets;
- packet scope is enforced across red, green, repair, and verify;
- executor attempts return structured evidence;
- a second blocked result ends in bounded human-needed state rather than an unbounded loop.

### Implementation

Refactor current scan handlers to return evidence-rich candidate contracts. Reuse current TDD handler and workspace protections for execution. The packet is the authoritative executor scope; free-form model output cannot expand it.

Executor guidance permits one revised attempt per configured policy and task budget. Agent Bridge chooses whether guidance is allowed and constructs the revised packet.

## Phase 8 — Documentation Steward lane

### Tests first

Prove:

- planning produces a documentation impact contract;
- final impact evaluation uses the implemented diff and evidence;
- `agentic-maintenance.yaml` trigger evaluation is deterministic;
- author mode mutates only allowed documentation paths;
- missing required documents block PR readiness;
- `no_documentation_change` requires rationale, trigger evaluation, and Technical Lead validation;
- documentation validation detects conflict with final behaviour or configuration;
- Documentation Steward fallback uses the same permission boundary.

### Implementation

Add job phases or workflow steps for:

1. documentation impact during planning;
2. documentation authoring after implementation verification;
3. documentation validation before readiness.

Antigravity may be the recommended initial target, but role resolution remains provider/model agnostic.

## Phase 9 — Technical Lead review and operations modes

### Tests first

Cover review preference order and independence reporting. Prove that:

- review occurs after deterministic verification;
- failed deterministic evidence cannot receive a ready verdict;
- different target is preferred where available;
- reused targets run in fresh isolated sessions;
- operations review is triggered for service, deployment, configuration, credentials, schema, migration, queue, lifecycle, backup, or rollback changes;
- operations verdict includes prerequisites, sequence, abort, rollback, and postconditions;
- human approval gates remain authoritative.

### Implementation

Fold implementation and operations verdicts into durable phase state. Use the Technical Lead role's resolved target, with a review-specific alternative resolved when available. Do not add separate reviewer or operations role configuration.

## Phase 10 — Platform role allocation

### Repository

Implement the platform portion in `agent-bridge-platform` as a coordinated PR or explicitly linked issue/PR. Do not mix repositories in one branch.

### API and persistence

Expose workspace role assignments, authenticated CLI inventory, discovered models, probe state, fallbacks, budgets, review preference, and effective/degraded status.

### UI

Provide Automatic, Recommended, and Manual modes. Display:

- role purpose;
- primary CLI/model and fallbacks;
- authentication and probe status;
- capability summary;
- permission profile;
- cost/budget controls;
- model-diversity and independent-review warnings;
- non-mutating test-role action.

Single-CLI and single-model setup must be supported without hiding degradation.

### Security

The platform stores references and configuration, not raw provider credentials where existing appliance authentication owns them. Follow the platform's authoritative secret and appliance credential boundaries.

## Phase 11 — Lifecycle, restart, cancellation, and audit

### Dependency

Coordinate with Issue #119. Do not implement a competing lifecycle system.

### Tests first

Cover cancellation during tool use and provider output, lease loss, stale owner, restart after every role phase, retry after provider failure, fallback, budget exhaustion, and terminal-state fencing.

### Implementation

Ensure:

- task-wide logical-call budgets survive restart;
- completed role phases do not rerun;
- late output cannot persist after cancellation or ownership loss;
- provider attempts and tool capabilities are terminated or expire;
- new calls revalidate effective role target and probe freshness;
- state transitions are authoritative and transactional where required.

## Phase 12 — Compatibility, rollout, and rollback

### Tests first

Add migration fixtures from representative current worker databases and configurations. Cover:

- no role records;
- only legacy chains;
- advisor disabled or partially configured;
- one CLI authenticated;
- current in-flight and completed jobs;
- rollback after role records exist.

### Implementation

Introduce role routing behind an explicit rollout flag or policy version. Migration may derive recommended assignments from current advisor/code/scribe chains but must not pretend they were manually selected.

Status reports configuration source and conflicts. Explicit role assignments win over legacy chains.

Rollback disables new role routing without deleting assignments or audit. Hold jobs whose new issue/plan state cannot be safely interpreted by the legacy path.

Follow `docs/operations/agentic-worker-runbook.md` for qualification.

## Phase 13 — Documentation and repository policy integration

Update or verify:

- `README.md` user-facing worker summary and links;
- `AGENTS.md` signposting and role boundaries;
- `docs/WORKER-GUIDE.md` commands, lifecycle, configuration, and troubleshooting;
- architecture, ADR, configuration, operations, testing, and production-readiness docs;
- `agentic-maintenance.yaml` paths and triggers;
- env examples and configuration tables;
- platform documentation.

The final implementation PR must revise target-state docs only when implementation evidence requires it. Do not silently weaken the agreed architecture to match an incomplete implementation.

## Expected implementation boundaries

Exact files depend on the current main tree, but the work should remain within these owners:

- central config and provider capability registry;
- advisor service/tool policy/contracts;
- worker role resolver and permission policy;
- worker work-item/job repositories and additive migrations;
- feature/defect/refactor intake and planning handlers;
- orchestrated task and TDD execution integration;
- documentation workflow handler;
- status and Telegram/platform projections;
- Architecture Lint and focused tests;
- coordinated platform API/UI changes in the platform repository.

Avoid new direct provider execution, raw SQL outside repositories, duplicate process supervision, or a second workflow state store.

## Verification matrix

### Focused

- role domain/config/repository tests;
- provider/model discovery and role resolver tests;
- permission profile and capability-token tests;
- requirements and canonical issue validators;
- feature/defect/refactor workflow tests;
- advisor evidence/tool boundary tests;
- planning and contract-repair tests;
- Code Worker mode enforcement;
- documentation manifest/path policy tests;
- lifecycle/cancellation/restart tests;
- migration and rollback tests;
- platform API/UI tests.

### Broad

Run at the exact final head:

```bash
npm test
npm run typecheck
bash scripts/arch-lint.sh src
npm run cleanup:check
git diff --check
```

Account for any pre-existing cleanup findings and prove no changed-file finding was introduced. Run the suite at least twice when lifecycle, concurrency, lease, or cancellation behaviour changed. Run serially where isolation risk warrants it.

### Live/disposable qualification

Demonstrate the ten scenarios in `docs/testing/agentic-worker-verification.md`, recording exact targets, models, role modes, permissions, state transitions, commits, verification, and degradation status.

No production deployment, service restart, database mutation, or platform rollout occurs without separate explicit approval.

## Execution Contract

```json
{
  "target_areas": [
    "worker role/configuration domain",
    "provider and model capability registry",
    "advisor service read-only evidence boundary",
    "work item/job repositories and migrations",
    "feature/defect/refactor intake handlers",
    "implementation planning and orchestration handlers",
    "TDD Code Worker integration",
    "documentation workflow and manifest enforcement",
    "status projections and platform role allocation",
    "tests, architecture lint, configuration examples, and documentation"
  ],
  "phase_order": [
    "current-state-reconciliation",
    "role-domain-red-green",
    "model-discovery-red-green",
    "permission-boundary-red-green",
    "requirements-contracts-red-green",
    "advisor-tools-red-green",
    "advisor-planning-red-green",
    "code-worker-modes-red-green",
    "documentation-steward-red-green",
    "review-operations-red-green",
    "platform-allocation-red-green",
    "lifecycle-red-green",
    "migration-rollout-red-green",
    "documentation-and-final-verification"
  ],
  "red_test_requirement": "Each behaviour slice begins with a boundary-level failing test committed without production implementation.",
  "verification_requirement": "Focused tests, full suite, typecheck, Architecture Lint, cleanup check accounting, git diff check, exact-head CI, migration/rollback tests, and disposable qualification.",
  "risk_level": "high",
  "human_decision_required": true,
  "human_gates": [
    "product decisions exposed by requirements discovery",
    "approval of role defaults and rollout policy",
    "merge",
    "production deployment or restart",
    "secret, permission, or destructive changes"
  ],
  "out_of_scope": [
    "unrestricted autonomous model-to-model loops",
    "model-owned workflow state or permissions",
    "separate scanner, reviewer, or operations role configuration",
    "automatic merge or deployment",
    "removing current fail-closed plan validation before replacement qualification"
  ]
}
```

## Completion criteria

The implementation is complete only when all Issue #159 acceptance criteria are proven at the exact final head, target-state documentation matches the delivered behaviour, platform role allocation is linked or complete, the migration and rollback paths are verified, and the retrospective reports either an existing rule covering all observed defects or a justified follow-up.