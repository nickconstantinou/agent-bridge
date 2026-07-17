# 01 — Current Architecture Review

Status: draft for review · Basis: repo at branch `docs/architecture-review-v1` (main @ cd431ff) · All claims traceable to file paths.

## 1. System overview

Agent Bridge OSS is a TypeScript/Node runtime (tsx, no build step) bridging messaging platforms (Telegram, Discord) to AI coding CLIs (Codex, Claude, Antigravity/Agy, Kimchi). Persistence is a single better-sqlite3 database. Three runtime capabilities exist today:

| Capability | Entry points | Core modules |
|---|---|---|
| Companion layer | `src/index.ts` (per-CLI bots), `src/index-interactive.ts` (unified Telegram), `src/index-discord-interactive.ts` (Discord) | `engine.ts`, `cli.ts`, `interactiveBot.ts`, `workerFallback.ts` |
| Worker bot | `src/index-worker.ts` | `workerBot.ts`, `jobExecutor.ts`, `jobExecutorLoop.ts`, `workCallbacks.ts`, `src/handlers/*` |
| Health/ops | `src/index-health.ts` | `src/health/*` (scheduler, plugins, autoRemediate) |

A second, separate **appliance** deployment lives outside this repo at `/opt/agent-bridge` (`src/appliance/*`: control-plane-agent, telegram-bot, caddy, deploy, health-loop). It shares no process with the dev repo services and has independently caused a Telegram token collision (`TELEGRAM_BOT_TOKEN_WORKER` == Agy token). See Risk Register.

## 2. Module inventory

### Companion / execution core
- `src/engine.ts` (1,337 lines) — BridgeEngine: polling loop, update handling, command dispatch, execution orchestration, retry/fallback, memory sidecars, event emission. Largest module; owns too many concerns (see Gap Analysis).
- `src/cli.ts` — generic invocation/result dispatch (`buildCliInvocation`, `parseCliResult`), fallback classification/model selection, and thin `runCli`/`runCliAsync` adapters over `cliSupervisor.runSupervisedProcess()`. Provider-specific builders/parsers live under `src/providers/*Runtime.ts`; Antigravity/Kimchi session/state helpers remain with their provider modules.
- `src/providers/registry.ts` — provider capabilities, including the authoritative `toolFree` policy used by invocation, advisor, and compaction paths. Internal callers import provider/config/database/supervisor owners directly; `src/bridge.ts` retains a compatibility barrel for established consumers.
- `src/cliSupervisor.ts` (576 lines) — Issue #135 Phase 2: the single authoritative child-process lifecycle. Owns argument normalisation (`normalizeCliArgs`), workspace-lock wrapping, child env/advisor-secret scrubbing (`buildSafeChildEnv`, `buildAdvisorChildEnv`), the one process registry and identity-checked registration/deregistration, hard/idle/planner-stall timers, event emission, cancellation/termination (`abortCliProcess*`, `shutdownCliProcesses*`), and close/error settlement (`runSupervisedProcess`). Re-exported from `src/cli.ts` for existing callers.
- `src/interactiveBot.ts` — CliKind type, per-chat CLI preference (SQLite), /cli switch keyboard, fallback dispatch helper.
- `src/workerFallback.ts` — CLI-to-CLI fallback chain with conversation-context preamble handoff.
- `src/commands.ts` — /models /effort /reset /stop /compact /context /usage /narration.
- `src/effort.ts`, `src/timeouts.ts` — per-CLI effort flags and timeout tables.
- `src/soul.ts` — SOUL.md persona context loading.

### Messaging / rendering
- `src/telegram.ts`, `src/discord.ts`, `src/discord-gateway.ts`, `src/platform.ts` — API clients + platform abstraction.
- `src/markdownIR.ts` (548) — markdown → IR → HTML/entities; `src/nativeLayout.ts`, `src/render.ts`, `src/messageDelivery.ts` — routing of rendered output (rich_message → card fallback).
- Worker bot still renders via legacy regex path, not the IR pipeline (known gap).

### Worker engine
- `src/workerBot.ts` (757) — Telegram command surface for work items (/features /defects /import etc.).
- `src/jobExecutor.ts` + `src/jobExecutorLoop.ts` — claim → execute → repair-enqueue loop over `work_jobs`; handler map injected from `src/index-worker.ts:216` (`handlers: {...}`).
- `src/handlers/` — 10 typed handlers: featurePlan, implementationPlan, tddImplementation, defectScan, refactorScan, orchestratedTask, prLifecycle, prWatch, prRefresh, githubIssue.
- `src/workspace.ts` — per-job disposable git clones (jobs never mutate the live checkout); origin re-pointed to real remote.
- `src/prMergeGate.ts`, `src/githubIssueClosure.ts` — merge approval + issue auto-close on merge (added 3f32062).
- `src/workerCliPolicy.ts`, `src/workerDispatch.ts` — which CLI/effort a job type uses.
- `src/implementationPlanQuality.ts` — plan quality scoring gate.
- `src/skills.ts` + `skills/` + `scripts/skill-manager.ts` — named prompt skill packs.

### Persistence
- `src/db.ts` (1,103) — BridgeDb monolith: schema DDL + migrations inline; session/lock/settings/queue/memory methods implemented directly.
- `src/repositories/` — 6 repository classes (session, lock, settings, runRepository, workQueue, memory). Partially wired: `settingsRepository` and `sessionRepository` are delegated to; `BridgeDb` still owns most SQL directly (`openDb()` returns `new BridgeDb(raw)`).
- `src/events/` — `types.ts` (BridgeEvent union: run.started, text.delta, run.completed, run.failed, run.cancelled), `store.ts` (EventStore persisting to `bridge_runs`/`bridge_events`), `reducer.ts`, `telegramAdapter.ts`.
- `src/projectMemory.ts`, `src/contextCommand.ts`, `src/compactSummary.ts` — memory capture, retrieval, /compact, context command CLI. `/compact` is the single automatic durable-memory distillation path; the former post-turn extractor (`src/memoryExtractor.ts`, `BRIDGE_MEMORY_EXTRACTOR_ENABLED`) has been removed.

### Tables (from `src/db.ts` DDL)
`bridge_state`, `settings`, `bridge_runs`, `bridge_events`, `work_items`, `work_jobs`, `approvals`, `github_links`, `feature_plans`, `work_item_plans`, `prompts`, `conversation_turns`, `pending_messages`, `conversation_summaries`, `project_memories`.

## 3. Runtime lifecycle

### Companion bots (`index.ts`)
1. dotenv (`BRIDGE_ENV_FILE`), config from env → one `BridgeEngine` per bot with a token.
2. Engine polls getUpdates (offset persisted per kind in settings), authorizes, dispatches commands or executes CLI.
3. Execution: `buildCliInvocation` → spawn → timeout/idle guards → `parseCliResult` → session persisted (`bridge_state.<kind>_session_id`) → render → deliver. Kimchi sessions resolved post-hoc from JSONL filenames (`resolveKimchiSessionId`, engine.ts:821).
4. Failure: `isCapacityExhaustedError` → model fallback (`getNextFallbackModel`) → CLI-chain fallback (interactive only) → user notification. Consecutive-failure circuit breaker clears sessions.

### Interactive bot (`index-interactive.ts`)
One token, four engines (codex/claude/antigravity/kimchi) constructed eagerly; per-chat preference in `bridge_state.interactive_cli_preference`; `WorkerFallbackChain` maintains cross-CLI conversation transcript for handoff preambles.

### Worker (`index-worker.ts`)
Command surface (workerBot) + job loop (jobExecutorLoop): claim pending `work_jobs` row → handler by `task_type` → status transitions (pending/running/succeeded/failed) with `max_attempts`, idempotency keys, repair-job enqueue for TDD failures (jobExecutor.ts:189). Hourly `pr_watch` self-enqueue (index-worker.ts:355). PR merge → auto-resolve work item + close GitHub issue.

### Provider execution
All CLIs run as child processes with `--print`-style headless flags; only stdout parsed; per-kind timeouts (30m hard / 20m idle); `KillMode=control-group` in systemd units prevents orphans; orphan pkill on startup.

## 4. State model

| State | Location | Durable? | Recovery |
|---|---|---|---|
| CLI sessions per chat | `bridge_state.<kind>_session_id` (+created_at) | Yes | 7-day TTL clear at startup; /reset |
| Polling offsets | `settings` `$polling:<bot>` | Yes | resume from offset+1 |
| Work items / jobs / approvals / plans | `work_items`, `work_jobs`, `approvals`, `work_item_plans`, `feature_plans` | Yes | jobs re-claimed by loop; orphaned `running` rows handled by cleanupOrphanedRuns + restart notification |
| Run history / events | `bridge_runs`, `bridge_events` (EventStore) | Yes (append) | not yet used for state derivation — audit only |
| Conversation turns/summaries | `conversation_turns`, `conversation_summaries` | Yes | /compact rebuilds summary |
| Project memory | `project_memories` | Yes | scoped retrieval (e8b1bf4) |
| In-flight child processes | process table only | No | killed on stop; orphan cleanup on start |
| Fallback-chain transcript | in-memory `WorkerFallbackChain` + turns table | Partial | preamble rebuilt from stored turns |
| Kimchi session files | `~/.config/kimchi/harness/sessions/*.jsonl` (external) | External | newest-file scan; fragile under concurrency (see Risks) |

## 5. Current abstractions (interfaces that exist)

| Concern | Abstraction today | Quality |
|---|---|---|
| Provider | `BotKind` union + if/else branches in `cli.ts` (buildCliArgs/parseCliResult) | Implicit — no adapter interface; adding a CLI touches 9+ files (proven by kimchi integration) |
| Storage | `BridgeDb` + partial `src/repositories/*` | Split incomplete |
| Messaging | `src/platform.ts` (Telegram/Discord) | Reasonable seam |
| Events | `BridgeEvent` union + `EventStore` | Exists, run-scoped only; worker jobs don't emit |
| Worker handlers | handler map keyed by `task_type` (index-worker.ts:216) | Good seam; workflows still hard-coded per handler |
| Workspaces | `src/workspace.ts` disposable clones | Good |
| Memory | `projectMemory.ts` + repository | Working; single-store, no per-kind memory model |
| Skills | `src/skills.ts` + skill packs | Exists; prompt-level only |

## 6. Test surface
75 test files, 1,335 passing (vitest). Static guard against vitest-in-src exists as a worker acceptance pattern (`handlers/tddImplementation.ts:14 TEST_ONLY_SOURCE_PATTERN`). One TODO/FIXME in src. Typecheck clean.
