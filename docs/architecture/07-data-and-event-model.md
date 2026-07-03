# 07 — Database & Event Model

## Current schema (from src/db.ts DDL)

| Table | Owner (target repository) | Purpose |
|---|---|---|
| bridge_state | sessionRepository / settingsRepository | per-chat sessions, failures, CLI preference |
| settings | settingsRepository | KV: polling offsets, model overrides, cooldowns |
| bridge_runs / bridge_events | runRepository / EventStore | run audit + event log |
| work_items / work_jobs / approvals | workQueueRepository | worker queue + gates |
| github_links | workQueueRepository | issue/PR ↔ work item links |
| feature_plans / work_item_plans | workQueueRepository | plan artifacts |
| prompts | settingsRepository | prompt/skill overrides |
| conversation_turns / conversation_summaries / pending_messages | memoryRepository (target) | conversation state |
| project_memories | memoryRepository | memory store |

## Planned migrations (additive only; better-sqlite3 try/alter pattern already established)

```sql
-- M-013 memory kinds (Epic 7)
ALTER TABLE project_memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'repository';
ALTER TABLE project_memories ADD COLUMN scope_ref TEXT;
CREATE INDEX IF NOT EXISTS idx_memories_kind_scope ON project_memories(kind, scope_ref);

-- M-014 job events (Epic 6)
ALTER TABLE bridge_events ADD COLUMN job_id INTEGER;          -- nullable; run events keep NULL
CREATE INDEX IF NOT EXISTS idx_events_job ON bridge_events(job_id, id);

-- M-015 external work sources (Epic 9)
ALTER TABLE work_items ADD COLUMN source TEXT NOT NULL DEFAULT 'telegram';  -- telegram|github
ALTER TABLE work_items ADD COLUMN external_ref TEXT;          -- owner/repo#123
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_external ON work_items(external_ref) WHERE external_ref IS NOT NULL;

-- M-016 provider cooldowns (Epic 8) — settings KV, no DDL:
--   key: cooldown:<kind>:<model>  value: iso-until
```

## Event flow (target)

```
workerBot /approve ──▶ ApprovalRequested→resolved ─┐
jobExecutorLoop claim ─▶ JobStarted ───────────────┤
handler steps ─────────▶ ProviderSelected,         ├─▶ bridge_events (append, same tx as
                         CommitCreated, PRCreated  │    materialized work_jobs.status update)
prWatch poll ──────────▶ ReviewReceived, CIFailed, │
                         Merged ───────────────────┘
                                   │
              ┌────────────────────┼──────────────────────┐
        reducer.ts           telegramAdapter         metrics (E10)
     (derive status)      (progress messages)     (durations, rates)
```

Invariants:
1. Event append and status-column update share one transaction (no divergence window).
2. Event write failure never blocks execution (preserve EventStore swallow semantics) — but increments a health counter.
3. Replay determinism: reducer(events(jobId)) == stored status, enforced by CI property test.
4. Events are immutable; corrections are new events.
