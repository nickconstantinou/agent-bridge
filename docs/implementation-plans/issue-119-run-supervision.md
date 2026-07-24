# Issue #119 implementation plan: durable run lifecycle and delivery state

Status: revised implementation-ready planning contract  
Updated: 18 July 2026  
Issue: #119 — Persist run lifecycle, cancellation, worker leases, and delivery state  
Branch: `plan/issue-119-run-supervision`

GitHub Issue #119 is the source of truth for scope, decisions, discussion, and acceptance status. This document translates that issue into a phased implementation plan for a coding agent.

## 1. Current baseline that must be preserved

The original version of this plan predated the Issue #135 Phase 2 process-lifecycle consolidation. The following work is already complete on `main` and is not part of Issue #119:

- `src/cliSupervisor.ts` owns the single authoritative local child-process lifecycle;
- `runCli()` and `runCliAsync()` are thin adapters over `runSupervisedProcess()`;
- one in-memory process registry owns both paths;
- children are launched in detached process groups;
- cancellation sends SIGTERM and escalates to bounded SIGKILL;
- waiting cancellation does not complete until the direct child closes and the process group is confirmed empty or the bounded liveness check expires;
- stale-child deregistration cannot remove a newer fallback/retry child;
- hard timeout, idle timeout, provider output watches, environment scrubbing, worktree locks, and sync/async settlement share the same lifecycle boundary.

This implementation must reuse those guarantees. Do not create another process registry, process controller, CLI supervisor, spawn abstraction, timeout owner, or signal escalation path.

The remaining problem is durable logical state around that local supervisor:

- one user or worker intention needs a stable `runId`;
- every provider spawn, fallback, or retry needs a distinct `attemptId`;
- cancellation intent must be persisted before local signalling;
- worker lease ownership and CLI attempt ownership must be correlated;
- restart reconciliation must classify non-terminal runs deterministically;
- Telegram activity must become a projection of run state rather than proof of progress;
- final delivery must be persisted and retried independently from execution.

## 2. Mandatory working method

Before production changes:

1. Read `AGENTS.md` and all linked repository instructions.
2. Read Issue #119 and this plan in full.
3. Read Issue #135 and the current state of PR #147.
4. Confirm the exact `main` commit and record the baseline full-suite, typecheck, Architecture Lint, and serial/leak results.
5. Inspect every current file and test named in section 5.
6. Confirm whether PR #147 has merged. Schema work must use the versioned migration boundary from #147; do not create a competing schema owner.

For each phase:

1. add focused failing tests first;
2. capture the expected red failure;
3. implement the narrowest coherent behavior;
4. run focused and directly affected suites;
5. commit the phase independently;
6. keep the PR draft until all phases and rollout evidence are complete.

Do not combine schema, interactive cancellation, worker leases, restart reconciliation, and delivery retry into one commit.

## 3. Locked design decisions

### 3.1 Local process execution and durable lifecycle are separate layers

`src/cliSupervisor.ts` remains the sole owner of:

- child spawning;
- child/process-group registration;
- environment construction and scrubbing;
- local hard and idle timers;
- provider process-watch callbacks;
- SIGTERM/SIGKILL escalation;
- close/error settlement;
- confirmed local process-group death.

The new durable lifecycle layer owns:

- logical run identity;
- provider attempt identity and ordering;
- persisted phase and ownership metadata;
- cancellation intent;
- compare-and-set terminal state;
- worker lease correlation;
- restart classification;
- activity timestamps;
- final delivery state.

The durable layer may pass `runId` and `attemptId` into the existing supervisor as metadata and receive bounded lifecycle callbacks. It must not duplicate the supervisor's process map or signalling logic.

### 3.2 Logical runs and provider attempts are different records

A logical run represents one user or worker intention. An attempt represents one local provider process.

Examples:

- one interactive Codex response: one run, one attempt;
- Codex capacity failure followed by Claude fallback: one run, two attempts;
- invalid Claude session followed by a fresh-session retry: one run, two attempts;
- a worker job with planning, implementation, and verification-related CLI calls: one job-correlated run with ordered attempts;
- a checkpointed worker job resumed after `status: "continue"`: the same logical run with later attempts.

Every spawn gets a new `attemptId`. Never reuse an attempt record for a retry or fallback.

### 3.3 Required state model

Run states:

```text
queued
  -> starting
  -> running <-> waiting
  -> cancellation_requested
  -> cancelling
  -> succeeded | failed | cancelled | orphaned
```

Attempt states:

```text
starting
  -> running
  -> cancelling
  -> succeeded | failed | cancelled | orphaned
```

Recommended bounded metadata:

```ts
interface RunRecord {
  runId: string;
  origin: "interactive" | "worker";
  surface: string;
  chatKey: string | null;
  chatId: string | null;
  threadId: string | null;
  jobId: number | null;
  workItemId: number | null;
  status: RunStatus;
  phase: string;
  ownerId: string | null;
  activeAttemptId: string | null;
  cancellationRequestedAt: string | null;
  cancellationReason: CancellationReason | null;
  lastActivityAt: string | null;
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
  failureCategory: string | null;
}

interface AttemptRecord {
  attemptId: string;
  runId: string;
  ordinal: number;
  provider: string;
  model: string | null;
  status: AttemptStatus;
  phase: string;
  ownerId: string;
  supervisorInstanceId: string;
  startedAt: string;
  lastActivityAt: string | null;
  lastHeartbeatAt: string | null;
  terminalAt: string | null;
  exitCategory: string | null;
}
```

Do not persist prompts, raw stdout/stderr, repository contents, hidden reasoning, tokens, credentials, attachment contents, or full error objects.

### 3.4 Schema and repository ownership

All schema changes must use the versioned schema and migration boundary established by Issue #135 Phase 4A / PR #147.

- If #147 has not merged, do not implement the schema phase on an obsolete database base. Rebase after #147 or coordinate explicitly with its branch owner.
- Add one numbered migration through the authoritative schema module.
- Cover all five production database roles where the schema is shared or validated.
- Reject future schema versions using the existing policy.
- Put all run, attempt, and delivery SQL behind explicit repositories.
- `BridgeEngine`, Telegram command handlers, worker handlers, `cliSupervisor.ts`, and transport code must not issue ad hoc SQL against the new tables.
- Preserve `BridgeDb` compatibility where current code requires it, but do not make it the permanent direct-SQL owner for the new domains.

### 3.5 Terminal transitions are compare-and-set

The first valid terminal transition wins. Completion, cancellation, timeout, process close, lease loss, shutdown, and restart reconciliation can race.

Repository terminal methods must:

- update only from allowed non-terminal states;
- return whether the caller won;
- leave the established terminal result unchanged when the caller loses;
- ensure losing callers perform no terminal side effects.

A run may become `succeeded` only after its required execution work has completed. Delivery failure does not change a successful execution into a failed run.

### 3.6 Cancellation is persisted before signalling

Cancellation order:

1. resolve the active run and attempt for the originating chat/topic or worker job;
2. persist `cancellation_requested` with reason and timestamp;
3. invoke the existing local fast path in `cliSupervisor.ts` when the attempt belongs to this process instance;
4. persist `cancelling` while local termination is outstanding;
5. settle attempt and run with compare-and-set;
6. retain execution-lane and worktree ownership until local process-group termination and durable terminal settlement are complete.

Persisted PIDs are diagnostic only. Never signal a PID or process group reconstructed solely from SQLite after restart.

### 3.7 Cancellation is a typed execution outcome

Cancelled output is not a successful partial response.

Use one typed contract consistently:

- a `CliCancellationError`; or
- a discriminated result such as `{ kind: "cancelled" }`.

TypeScript and tests must force callers to handle cancellation before normal provider-result parsing.

After cancellation wins, do not:

- parse or send partial stdout as a final answer;
- persist a provider session;
- reset provider failure counts as success;
- add conversation history or project memory;
- invoke success hooks;
- upload generated files as successful artifacts;
- trigger capacity fallback or fresh-session retry;
- create repair work as though cancellation were an unexpected failure;
- emit a successful completion event.

Temporary files may still be cleaned up safely.

### 3.8 `/stop`, `/cancel`, and `/stop all`

- `/stop` and `/cancel` cancel only the active run for the originating surface and chat/topic.
- `/stop all` cancels the active run and clears queued messages for that same lane.
- A normal `/stop` must not delete queued user messages.

Responses must distinguish:

- nothing running;
- cancellation requested;
- cancellation completed;
- already terminal;
- termination failed;
- queued-message count cleared by `/stop all`.

### 3.9 Worker lease is the worker ownership heartbeat

Extend the existing `work_jobs` lease renewal. Do not add a second worker lease.

A successful renewal should atomically or transactionally coordinate:

- job lease ownership;
- run owner;
- active attempt owner;
- last successful heartbeat;
- phase/activity metadata;
- lease expiry.

On persistent renewal failure or lost ownership:

- stop beginning new external side effects;
- prevent Git commit, push, PR, approval, merge, deployment, or cleanup transitions that require ownership;
- terminate or checkpoint the local attempt safely;
- settle it as `lease_lost`/`orphaned` using the bounded failure taxonomy;
- reconcile before reclaiming so external effects are not blindly repeated.

### 3.10 Telegram activity is a projection

Preserve the transport-appropriate typing refresh cadence. Database heartbeat cadence cannot replace Telegram typing because typing expires much sooner.

Create one activity projection driven by non-terminal run state for both sync and async interactive paths. Typing failures remain non-fatal and never prove meaningful progress.

Provider narration remains separate:

- sanitized Antigravity `STATUS` narration may update the user-facing message;
- narration content is not persisted as heartbeat state;
- no fabricated percentages are allowed.

### 3.11 Execution and final delivery are independent

Persist final delivery separately from execution state.

Recommended delivery states:

```text
pending -> sending -> delivered
                  -> retryable_failure
                  -> permanent_failure
```

Delivery records may contain only bounded metadata:

- run id;
- surface/chat/thread destination identifiers;
- message kind;
- attempt count;
- next retry time;
- sanitized error category and bounded text;
- delivered timestamp.

Delivery retry must never rerun the CLI or mutate the established run terminal state.

## 4. Suggested module boundaries

Names may change, but responsibilities must remain separated.

```text
src/runtime/
  runTypes.ts                  provider-neutral state and result types
  runRepository.ts             all run/attempt SQL and CAS transitions
  runCoordinator.ts            orchestration around the existing cliSupervisor
  cancellation.ts              typed cancellation outcomes and mapping
  reconciliation.ts            startup classification of non-terminal records
  deliveryRepository.ts        final-delivery persistence and retry claims
  telegramActivityProjection.ts run-state-to-typing projection
```

Existing ownership:

```text
src/cliSupervisor.ts           sole local child/process-group owner
src/cli.ts                     public adapters and provider invocation dispatch
src/jobExecutor.ts             work-job lease owner and renewal loop
src/messageDelivery.ts         transport send/progress behavior
src/engine.ts                  interactive orchestration and command routing
```

Do not add `processController.ts`, a second `runSupervisor.ts`, or a new process registry.

## 5. Current code map to inspect

### Local process lifecycle

- `src/cliSupervisor.ts`
  - `activeExecutions`;
  - `runSupervisedProcess()`;
  - registration and stale-child fencing;
  - `abortCliProcessAndWait()`;
  - `abortExecutionAndWait()`;
  - shutdown variants;
  - hard/idle timer settlement;
  - execution-lane lifecycle handles.
- `src/cli.ts`
  - sync/async adapters;
  - provider invocation construction and result parsing;
  - fallback-facing error contracts.
- `src/workspaceLock.ts`
  - lock acquisition and supervised lock waiters.

### Interactive execution

- `src/engine.ts`
  - surface/chat/topic identity;
  - queue claiming and execution-lane ownership;
  - `/stop` and `/cancel` interception;
  - `abortedChats` compatibility state;
  - sync/async execution paths;
  - invalid-session retry;
  - capacity fallback;
  - memory/session/generated-file success side effects;
  - startup queue recovery.
- `src/messageDelivery.ts`
  - typing refresh;
  - progress callbacks;
  - final send/error paths.
- Telegram and Discord entry points for startup reconciliation and notification routing.

### Engineering Worker

- `src/jobExecutor.ts`
  - claim and running transitions;
  - heartbeat renewal;
  - `continue` checkpoints;
  - terminal settlement and repair behavior.
- `src/jobExecutorLoop.ts`
  - reclaim selection and tick serialization.
- `src/index-worker.ts`
  - worker identity, handler wiring, shutdown, advisor checkpoints.
- `src/workerDispatch.ts`
  - provider fallback for background calls.
- handlers that perform multiple CLI calls or external Git/GitHub effects.

### Persistence and events

- versioned schema/migration modules from PR #147;
- `src/db.ts` compatibility façade;
- `src/events/types.ts` and `src/events/store.ts`;
- current startup orphan cleanup and run event creation.

### Existing tests

Locate all tests for:

- process-group cancellation and timeout races;
- execution-lane and worktree-lock ownership;
- `/stop`, queue retention, topic isolation, fallback, invalid-session retry, memory and file output;
- typing and final delivery failure;
- event terminal deduplication;
- startup orphan cleanup;
- job claim, heartbeat, lease loss, reclaim, continue checkpoints, repair jobs, approval and merge gates;
- service shutdown.

Use fake children, fake clocks, temporary SQLite databases, and transport fakes. Do not add real sleeps, real Telegram traffic, or live provider calls to unit tests.

## 6. Phased implementation

### Phase 0 — Baseline and migration coordination

- rebase onto current `main` after PR #147 merges, or explicitly coordinate the schema commit with its owner;
- record exact baseline commands and any accepted pre-existing failures;
- add architecture tests preventing a second process registry/supervisor;
- confirm no production deploy or database mutation is part of early phases.

Exit gate: clean baseline and agreed schema owner.

### Phase 1 — Durable schema and repositories

Red tests first for:

- legacy/current/future schema behavior;
- migration rollback;
- run creation;
- attempt ordinal uniqueness;
- active-run lookup by surface/chat/topic and by job;
- legal and illegal state transitions;
- compare-and-set terminal winner;
- bounded persisted metadata;
- delivery record claiming and retry state.

Implement:

- numbered schema migration;
- run repository;
- attempt repository or one combined lifecycle repository;
- delivery repository;
- typed records and failure categories.

Exit gate: repository tests green across all relevant database roles; no runtime callers migrated yet.

### Phase 2 — Existing supervisor metadata bridge

Red tests first for:

- every local spawn receiving a unique attempt id;
- fallback/retry creating a new attempt;
- metadata callbacks not changing existing spawn, timeout, signal, or settlement behavior;
- stale close callbacks unable to settle a newer attempt.

Implement the minimum metadata seam around `runSupervisedProcess()`:

- accept or create `runId`/`attemptId` through options owned above the supervisor;
- notify the run coordinator of start, activity, local cancellation, and settlement;
- preserve one process map and all current public adapter behavior.

Exit gate: existing CLI fixture and process-supervision suites remain byte/behavior compatible except for intentional typed cancellation changes scheduled in Phase 4.

### Phase 3 — Interactive run registration and command cancellation

Red tests first for:

- one run per claimed interactive message;
- topic-specific active-run lookup;
- cancellation persisted before signalling;
- `/stop` preserving queued messages;
- `/stop all` clearing only the same lane;
- lane/worktree ownership retained until durable terminal settlement;
- exact response outcomes.

Implement:

- run creation after queue/lane ownership is secured and before provider spawn;
- active attempt registration;
- persisted cancellation command path;
- existing local `abortExecutionAndWait()` fast path;
- temporary compatibility adapters for `abortedChats` until Phase 9.

Exit gate: existing queue/topic isolation remains unchanged; cancellation order is proven.

### Phase 4 — Typed cancellation and success-side-effect fencing

Red tests first for every prohibited post-cancellation side effect.

Implement one typed cancellation outcome throughout:

- `cliSupervisor.ts` settlement;
- `cli.ts` adapters;
- engine sync/async paths;
- provider fallback and fresh-session retry;
- session persistence;
- memory/history/hooks;
- generated-file upload;
- worker dispatch.

Exit gate: cancellation can race completion, timeout, and fallback with one durable terminal winner and no success-side effects after cancellation wins.

### Phase 5 — Worker job and lease integration

Red tests first for:

- stable run id across `continue` phases;
- new attempt id for each CLI spawn;
- lease renewal updating run/attempt ownership metadata;
- transient renewal failure recovery;
- persistent failure/lost ownership preventing new side effects;
- reclaim reconciliation after partial external effects;
- shutdown and cancellation of owned attempts.

Implement by extending the existing job lease heartbeat. Do not add another lease timer.

Exit gate: worker ownership, run ownership, and external-effect gates cannot diverge silently.

### Phase 6 — Run-driven Telegram activity

Red tests first for:

- typing during starting/running/waiting/cancelling;
- one projection for sync and async paths;
- non-fatal typing errors;
- projection stop on every terminal state;
- narration remaining sanitized and non-persisted.

Migrate current typing ownership without changing user-visible cadence.

Exit gate: no duplicate typing intervals and no heartbeat-content persistence.

### Phase 7 — Restart reconciliation

Red tests first for startup with every non-terminal state:

- interactive attempt owned by a dead prior process;
- worker attempt with live valid lease;
- worker attempt with expired/lost lease;
- cancellation requested before crash;
- delivery pending after successful execution;
- diagnostic PID present but unsafe to signal.

Implement deterministic classification:

- mark unrecoverable interactive attempts interrupted/orphaned;
- notify the originating surface where delivery is possible;
- preserve valid live worker ownership;
- resume only from authoritative durable worker checkpoints;
- never signal persisted PIDs.

Exit gate: every non-terminal state has a tested startup outcome.

### Phase 8 — Independent final delivery and retry

Red tests first for:

- successful execution plus failed Telegram send;
- restart with pending/retryable delivery;
- duplicate retry claims;
- permanent destination failure;
- delivery retry not invoking any CLI;
- bounded/sanitized error storage.

Implement delivery claims and retry scheduling through the existing transport boundary.

Exit gate: execution terminal state and delivery terminal state are independently queryable and correct.

### Phase 9 — Compatibility retirement and architecture enforcement

Only after parity and rollout evidence:

- remove `abortedChats` and any transient run markers made redundant;
- remove duplicate typing ownership;
- remove obsolete startup orphan/event plumbing;
- retain `cliSupervisor.ts` as the sole process owner;
- add Architecture Lint rules against new ad hoc run SQL, process registries, or signal owners;
- update operator and architecture documentation.

Exit gate: no compatibility removal without tests and rollback review.

## 7. Failure and race matrix

Cover at minimum:

| Scenario | Required result |
|---|---|
| user cancellation during provider output | cancellation wins or loses by CAS; never partial success |
| cancellation races normal close | one terminal winner and one set of side effects |
| hard/idle timeout races cancellation | bounded category, no duplicate terminal work |
| fallback after capacity error | same run, new attempt id |
| invalid-session fresh retry | same run, new attempt id |
| process leader exits before descendant | existing process-group kill guarantee preserved |
| typing API failure | run continues; bounded diagnostic only |
| final delivery failure | run remains succeeded; delivery retries independently |
| one lease renewal failure | retry within remaining lease budget |
| persistent lease failure | stop new effects; terminate/checkpoint; mark lost/orphaned |
| worker crash after Git/GitHub effect | reconcile before reclaim; do not blindly repeat |
| service restart with active interactive run | mark interrupted/orphaned; never signal stored PID |
| shutdown during cancellation | bounded local termination and deterministic durable state |
| control-plane outage | OSS execution follows local ownership policy; no fabricated progress |

## 8. Privacy and observability

Allowed persisted/logged metadata:

- ids and origin/surface;
- provider/model labels;
- bounded phase/status;
- timestamps and durations;
- lease expiry and renewal outcome;
- sanitized failure category and bounded message;
- delivery destination identifiers already required for routing.

Forbidden:

- prompts or conversation content;
- raw stdout/stderr;
- hidden reasoning;
- repository file content or diffs;
- tokens, credentials, secrets, private keys;
- attachment contents;
- fabricated progress percentages.

Events should represent meaningful transitions, not every heartbeat tick.

## 9. Validation gates

For every implementation phase:

- focused tests pass;
- directly affected suites pass;
- `npm run typecheck` passes;
- Architecture Lint passes;
- `git diff --check` passes.

Before ready-for-review:

- full suite passes in normal parallel mode;
- full suite passes serially or the approved serial/leak diagnostic passes;
- process-leak and open-handle checks pass;
- schema and rollout-helper tests pass after #147 integration;
- review threads are resolved;
- PR head is current with `main`;
- exact-head CI passes.

## 10. Rollout gates

This issue changes durable execution state and must use guarded rollout.

1. Deploy only after the migration ownership/gate from Issue #135 is approved.
2. Back up and validate every relevant database role.
3. Validate schema versions before restart.
4. Restart one non-production or single-instance service first.
5. Exercise interactive success, cancellation, queued-message retention, fallback, worker lease renewal, restart reconciliation, and failed delivery retry.
6. Confirm no orphaned child process groups, duplicate worker effects, secret-bearing logs, or unbounded heartbeat rows.
7. Record rollback boundaries. A binary rollback must not silently open an unsupported future schema.
8. Expand rollout only after observed evidence is attached to the PR.

No production deployment, restart, database mutation, or compatibility removal is authorized merely by merging this planning document.

## 11. Suggested commit sequence

1. `test: define durable run and attempt transitions`
2. `feat: add versioned run lifecycle repositories`
3. `test: define supervisor metadata integration`
4. `feat: correlate existing supervisor attempts with runs`
5. `test: define persisted interactive cancellation semantics`
6. `feat: register and cancel interactive runs`
7. `test: fence success side effects after cancellation`
8. `refactor: introduce typed cancellation outcome`
9. `test: define worker lease and attempt ownership`
10. `feat: integrate worker leases with durable runs`
11. `test: define run-driven Telegram activity`
12. `refactor: project Telegram activity from run state`
13. `test: define restart reconciliation`
14. `feat: reconcile non-terminal runs on startup`
15. `test: define execution-independent delivery retry`
16. `feat: persist and retry final delivery`
17. `refactor: retire superseded transient lifecycle state`
18. `docs: record lifecycle operations and rollout evidence`

## 12. Completion rule

PR #120 remains a draft planning workspace. It references Issue #119 but must not close it merely by merging documentation.

Issue #119 closes only when the runtime implementation, migrations, complete tests, exact-head CI, guarded rollout evidence, and required documentation are merged.
