# 01 — Current Architecture

Status: current architecture record · Validated against the active PR #160 branch on 19 July 2026 · Exact review head and checks are recorded in the pull request evidence.

This document describes behaviour and ownership that exist in the Agent Bridge OSS repository. Target-state role orchestration is documented separately and is not represented here as active merely because its prompt or schema foundation exists.

## 1. System overview

Agent Bridge OSS is a TypeScript/Node runtime connecting Telegram and Discord surfaces to supported coding CLIs. The repository contains three main runtime capabilities:

| Capability | Entry points | Core owners |
|---|---|---|
| Companion layer | `src/index.ts`, `src/index-interactive.ts`, `src/index-discord-interactive.ts` | `src/engine.ts`, `src/cli.ts`, `src/interactiveBot.ts`, `src/workerFallback.ts`, provider runtimes |
| Engineering Worker | `src/index-worker.ts` | `src/workerBot.ts`, `src/jobExecutor.ts`, `src/jobExecutorLoop.ts`, `src/workCallbacks.ts`, `src/handlers/*` |
| Health and operations | `src/index-health.ts` | `src/health/*` |

The hosted control plane and appliance lifecycle live in the separate `agent-bridge-platform` repository. The OSS repository owns the bridge and worker runtime installed on an appliance; it does not own the platform database, API, UI, desired configuration, or fleet deployment control plane.

Each runtime opens an explicitly configured SQLite database through the appropriate database boundary. Production services may use separate database paths by service role; the architecture must not assume one physical database file for every process.

## 2. Companion and provider execution

### Core orchestration

- `src/engine.ts` owns messaging update handling, command dispatch, conversation execution, fallback coordination, memory/context integration, event emission, and response delivery for companion surfaces.
- `src/cli.ts` provides provider-neutral invocation/result dispatch and thin adapters over the supervisor.
- `src/cliSupervisor.ts` is the sole child-process lifecycle owner. It owns process registration, argument and environment preparation, workspace-lock wrapping, timeouts and watches, cancellation, termination, and settlement.
- `src/providers/registry.ts` owns provider capabilities and policy metadata.
- `src/providers/codexRuntime.ts`, `claudeRuntime.ts`, `antigravityRuntime.ts`, and `kimchiRuntime.ts` own provider-specific invocation and parsing.
- `src/workerFallback.ts` owns cross-CLI companion fallback and conversation handoff.
- `src/worktreeLock.ts` and the supervisor/workspace boundaries protect shared Git worktrees from concurrent CLI mutation.

Provider identity does not grant lifecycle or mutation authority. Callers select a provider through configuration and policy; the supervisor remains provider-neutral.

### Messaging and rendering

- `src/telegram.ts`, `src/discord.ts`, `src/discord-gateway.ts`, and `src/platform.ts` own messaging API and platform boundaries.
- `src/markdownIR.ts`, `src/nativeLayout.ts`, `src/render.ts`, and `src/messageDelivery.ts` own the primary structured rendering path.
- Some worker-specific responses still use their existing formatting path; this does not create a second workflow or execution authority.

## 3. Engineering Worker

### Active worker lifecycle

`src/index-worker.ts` constructs the current handler map and starts the existing command surface and executor loop.

The active lifecycle is:

```text
work item or scheduled job
→ durable `work_jobs` record
→ claim/lease through the current repository and executor loop
→ handler selected by existing `task_type`
→ bounded CLI or Git/GitHub operation through injected owners
→ durable result, repair job, approval state, PR lifecycle, or terminal status
```

Current owners include:

- `src/workerBot.ts` — Telegram work-item and job command surface;
- `src/jobExecutor.ts` and `src/jobExecutorLoop.ts` — claim, execute, retry/repair enqueue, cancellation, and terminal fencing;
- `src/workCallbacks.ts` — callback ownership and approval actions;
- `src/workspace.ts` — disposable implementation workspaces;
- `src/workerCliPolicy.ts` and `src/workerDispatch.ts` — current effective legacy CLI-chain policy and dispatch;
- `src/prMergeGate.ts` and PR lifecycle handlers — exact PR state, human merge authority, and related work-item completion;
- `src/handlers/featurePlan.ts`, `implementationPlan.ts`, `tddImplementation.ts`, `defectScan.ts`, `refactorScan.ts`, `orchestratedTask.ts`, `githubIssue.ts`, and PR handlers — existing task implementations.

Existing red/green TDD guards, disposable workspaces, queue/lease semantics, provider fallback, GitHub mutation helpers, and human merge gate remain authoritative.

### Role-orchestration foundation delivered by PR #160

PR #160 adds source-controlled role/mode prompt contracts, canonical lifecycle-skill composition, stronger implementation-plan validation, and schema migration 2. It does **not** activate role-based routing.

The branch currently contains:

- `src/agenticPromptContracts.ts` — versioned Technical Lead, Code Worker, and Documentation Steward prompt contracts, including pre-mutation decomposition review;
- `src/lifecycleSkillGuidance.ts` — deterministic extraction, validation, composition, and identity of canonical skill guidance;
- `src/implementationPlanQuality.ts` — comprehensive red-test, coverage, and target-path provenance gate;
- `prompts/worker/roles/*` — separate role/mode prompts;
- source-only compatibility prompts for current handlers;
- schema migration 2 removing the absent or empty legacy prompt-override table.

Until later Issue #159 slices are implemented and approved:

- `src/workerCliPolicy.ts` remains the effective worker provider policy;
- existing task types and handlers remain active;
- no durable role assignment, capability resolver, permission profile, requirements lifecycle, Documentation Steward execution lane, or Technical Lead review phase is active;
- prompt contracts describe and protect the target workflow but do not themselves create lifecycle state or authority.

## 4. Persistence

### Database boundary

- `src/db.ts` is the `BridgeDb` compatibility façade. It checks schema compatibility before normal operation, constructs repository owners, delegates existing public methods, and performs bounded non-schema maintenance.
- `src/db/schema.ts` owns schema versioning and the ordered migration registry. At the PR #160 foundation, `CURRENT_SCHEMA_VERSION` is `2`.
- `src/db/legacyBaselineMigration.ts` owns migration 1 and its historical compatibility repairs.
- `src/db/dropLegacyPromptOverridesMigration.ts` owns migration 2. It treats an absent prompt table as already retired, drops an empty table transactionally, and rejects unexpected rows without logging their content.
- `openProductionDb()` remains strict: production services do not migrate automatically at startup.
- Issue #135 and the guarded rollout helper own production database inventory, backup, migration, validation, restart sequencing, rollback, and sentinel evidence.

### Repository ownership

SQL is owned by focused classes under `src/repositories/`, with `BridgeDb` retaining its compatibility façade. Current repositories own sessions, locks, settings, runs/events, worker queues and work items, memory, compaction, advisor records, and conversation records.

`pending_messages` remains the documented compatibility exception coupled to lock/lease ownership. New work must not add SQL to handlers, configuration, status, prompt loaders, AdvisorService, or GitHub helpers.

### Durable state

Durable state includes:

- provider sessions and settings;
- polling offsets;
- work items, jobs, approvals, plans, and GitHub links;
- run and event audit records;
- conversation turns and summaries;
- project memories;
- pending-message/lock state.

Events are an audit projection, not the authoritative worker lifecycle state. Work item/job records, leases, terminal fencing, and approvals remain authoritative.

## 5. Memory and context

- `src/projectMemory.ts` and its repository own durable project memory.
- `/compact` and `src/compactSummary.ts` are the automatic durable-memory distillation path.
- `src/contextCommand.ts` provides context inspection and retains its documented read-only database exception.
- The removed post-turn memory extractor and its enablement flag are not part of the current architecture.

## 6. Current authority boundaries

| Concern | Current authoritative owner |
|---|---|
| Provider-specific invocation | `src/providers/*Runtime.ts` |
| Child-process lifecycle | `src/cliSupervisor.ts` |
| Shared worktree exclusion | `src/worktreeLock.ts` and workspace/supervisor integration |
| Worker queue, work items, approvals, and GitHub links | current work repository behind `BridgeDb` |
| Worker claim/lease/retry/cancellation | `src/jobExecutor.ts`, `src/jobExecutorLoop.ts`, repository state |
| Current effective worker CLI policy | `src/workerCliPolicy.ts` and `src/workerDispatch.ts` |
| Implementation planning validation | `src/implementationPlanQuality.ts` |
| TDD red/green enforcement | `src/handlers/tddImplementation.ts` and current Git guards |
| Advisor invocation, fallback, redaction, and audit | `src/advisorService.ts` and advisor owners |
| Prompt and lifecycle-skill source | registered repository files and canonical skill loader |
| Database schema | `src/db/schema.ts` and numbered migration modules |
| GitHub issue/PR mutation | current GitHub handlers/helpers, never a model |
| Merge | existing human approval and `src/prMergeGate.ts` |
| Production migration/restart | Issue #135 guarded rollout path and human operator approval |

## 7. Verification surface

The repository uses Vitest, TypeScript typecheck, Architecture Lint, cleanup/static checks, rollout-helper qualification where applicable, and Git diff/exact-head CI evidence.

Test totals and file counts are deliberately not duplicated here because they are volatile. Exact counts, commands, skipped tests, and current head are recorded in the reviewed PR or deployment evidence.

Important test classes include:

- provider runtime and fallback compatibility;
- supervisor cancellation, timeout, and settlement;
- worktree isolation;
- worker queue, lease, callback, and handler lifecycle;
- TDD red/green Git boundaries;
- database migrations, strict production opening, repository ownership, and rollback;
- AdvisorService budgets, fallback, evidence, redaction, and audit;
- prompt contract, lifecycle-skill, plan-quality, and compatibility wiring;
- PR lifecycle and human merge gating.

## 8. Known current gaps and planned owners

The following are not active current behaviour and remain owned by Issue #159 child slices:

- durable role domain, assignment revisions, and dormant status;
- model/capability discovery and deterministic role resolution;
- mode-specific permission enforcement;
- requirements validation and canonical issue revision lifecycle;
- bounded Technical Lead evidence tools and role-native planning;
- scan-candidate disposition and immutable execution packets;
- Documentation Steward authoring/validation lane;
- Technical Lead implementation/operations/readiness phases;
- durable cross-phase audit, restart, compatibility, and rollout qualification;
- platform desired/effective role allocation.

These capabilities must extend the current owners rather than introduce a new workflow engine, queue, supervisor, state store, provider stack, GitHub mutation path, merge path, or platform configuration transport.
