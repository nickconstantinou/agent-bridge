# 03 — Target Architecture

Evolution of the existing codebase, not a rewrite. Every layer below maps to modules that already exist; new elements are marked ★.

## Layer diagram

```
┌────────────────────────── Interfaces ──────────────────────────┐
│ Telegram bots · Interactive router · Discord · Worker commands │
│ (telegram.ts, interactiveBot.ts, discord*.ts, workerBot.ts)    │
├────────────────────────── Companion ───────────────────────────┤
│ Router★ (intent → engine)  Session mgr (bridge_state)          │
│ Fallback chains (workerFallback.ts)  Rendering (markdownIR)    │
├────────────────────────── Orchestration ───────────────────────┤
│ Worker Engine (jobExecutor+Loop)   Workflow Engine★            │
│ Approval gates (prMergeGate)       Skills (skills.ts)          │
├────────────────────────── Providers ───────────────────────────┤
│ ProviderAdapter★: codex · claude · antigravity · kimchi        │
│ (extracted from cli.ts/effort.ts/timeouts.ts branches)         │
├────────────────────────── Runtime ─────────────────────────────┤
│ Workspaces (workspace.ts)  Event Store (events/*)              │
│ Memory (projectMemory + kinds★)  Locks/Repos (repositories/*)  │
├────────────────────────── Persistence ─────────────────────────┤
│ SQLite via repositories only★ (BridgeDb = facade)              │
└────────────────────────────────────────────────────────────────┘
   Platform (hosted): auth, billing, provisioning — OUT OF SCOPE,
   integrates via Workspace Bootstrap API★ + Heartbeat API★ only.
```

## Key decisions (full ADRs in doc 04)

1. **ProviderAdapter interface** replaces BotKind branch logic. Registry-driven; unions become `keyof registry`. Capabilities: `{ streaming, resume, interrupt, effort, models, attachments }`.
2. **Events become the write path** for worker lifecycle. `work_jobs.status` retained as a materialized view derived by `events/reducer.ts`. Extends the existing EventStore rather than introducing a bus dependency; the "bus" is table + in-process subscribers.
3. **Declarative workflows**: `Workflow = { name, steps: Step[], gates, repairPolicy }` interpreted by one engine; current handlers become step executors. Feature/bug/review/refactor/docs/security/release are data, not code.
4. **Single config loader** (`src/config.ts`), consumed by all entry points.
5. **Repositories own SQL**; arch-lint forbids `prepare(` outside `src/db/` and `src/repositories/`.
6. **Memory kinds** on one table: `kind ∈ {workspace, repository, conversation, provider, decision, review, failure}` + `scope_ref`. Typed accessors; capture hooks in review and repair paths.
7. **GitHub issues authoritative** for externally-created work; sync job reconciles; SQLite remains authoritative for jobs/runs (execution state never lives in GitHub).
8. **OSS/platform boundary**: OSS exposes two stable APIs (Workspace Bootstrap, Heartbeat/Status); platform code never imports OSS internals; appliance consumes a published client.

## Reference-project influences (patterns only, no code import)

| Source | Adopted pattern | Where |
|---|---|---|
| gstack | Named engineering skills as first-class workflow steps; planning discipline (plan artifact gates implementation); review/QA as separate pipeline stages | Workflow Engine, skills.ts, implementationPlanQuality.ts |
| agent-orchestrator | Adapter abstraction per agent; durable event model as truth; isolated worktrees; runtime supervision & lifecycle | ProviderAdapter, Event Store, workspace.ts, jobExecutorLoop |
| Rejected | Claude-specific assumptions, interactive-only flow, Electron/desktop, loopback daemon | — |
