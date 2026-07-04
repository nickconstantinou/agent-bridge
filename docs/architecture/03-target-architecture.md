# 03 — Target Architecture

Evolution of the existing codebase, not a rewrite. Every layer below maps to modules that already exist; new elements are marked ★.

## Mission

> Agent Bridge is an open-source runtime for autonomous AI agents. It consists of a domain-agnostic **Companion Runtime** for conversational AI agents and a specialized autonomous **Engineering Worker** for software development. Both share a common runtime providing provider abstraction, memory, eventing, capability management, and infrastructure services. The hosted Agent Bridge Platform provisions, manages, and monitors deployments, but all autonomous execution lives within the OSS.

## Two products, one shared runtime (ADR-008)

```
                Agent Bridge OSS
                       │
      ┌────────────────┴────────────────┐
      │                                 │
Companion Runtime              Engineering Worker
(domain-agnostic)              (software engineering only)
      │                                 │
Telegram/Discord/future        Work item → plan → arch review
surfaces → conversation        → TDD → implement → test →
router → provider selection    review → repair → PR → CI →
→ sessions → usage/fallback    reviewer comments → merge gate
→ memory → response            Owns: repos, worktrees, Git,
Knows nothing of Git/PR/CI     GitHub, CI, releases. Nothing else.
      └────────────────┬────────────────┘
                Shared Runtime
  SQLite · Event store · Memory · Provider adapters ·
  CLI mgmt · Config/secrets · Notifications · Metrics ·
  Capability Registry★ (Tranche 2 — ProviderAdapter is member #1)
```

Boundary rule (enforced by arch-lint, Epic 11): companion modules (`engine.ts`, `interactiveBot.ts`, router) never import worker modules (`workerBot`, `jobExecutor*`, `handlers/*`, `prMergeGate`, `workspace`) and vice versa; both import only Shared Runtime.

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

| Source | Adopted pattern | Layer influenced |
|---|---|---|
| gstack | Named engineering skills as first-class workflow steps; planning discipline (plan artifact gates implementation); review/QA as separate pipeline stages | **Engineering Workflows** (Workflow Engine, skills.ts, implementationPlanQuality.ts) |
| agent-orchestrator | Adapter abstraction per agent; durable event model as truth; isolated worktrees; parallel sessions; feedback routing; runtime supervision | **Engineering Worker** (ProviderAdapter, Event Store, workspace.ts, jobExecutorLoop) |
| Agent-Reach (github.com/Panniantong/Agent-Reach) | Capability layer giving agents internet access (web pages, YouTube transcripts, social platforms, RSS, semantic search) with per-channel primary+fallback backends and a `doctor` diagnostic | **Companion Runtime** + Capability Registry shape; its fallback-chain-per-channel pattern independently validates Epic 8. Near-term: installable as a host tool for the CLIs directly, zero bridge code |
| Rejected | Claude-specific assumptions, interactive-only flow, Electron/desktop, loopback daemon | — |

Rule: each external influence maps to exactly one layer — general-purpose agent capabilities never blend into the engineering-specific worker.
