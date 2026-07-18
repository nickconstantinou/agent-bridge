# 07 — Database & Event Model

## Schema versioning boundary

SQLite `PRAGMA user_version` is the authoritative schema marker. `user_version = 0` denotes the pre-versioned legacy baseline. Phase 4A establishes `CURRENT_SCHEMA_VERSION = 1`. Migration 1 (`applyLegacyCompatibleBaseline` in `src/db/legacyBaselineMigration.ts`) owns the full legacy DDL and every historical shape-detected repair, applied once, transactionally, advancing legacy databases straight to version 1. `openDb()` version-gates before WAL mode or any write — future, negative, or non-integer versions fail closed and the connection is closed before rethrowing. The migration runner (`applyMigrationsUpTo` in `src/db/schema.ts`) suspends `foreign_keys` enforcement around the whole migration transaction (a documented no-op if toggled inside one), verifies `PRAGMA foreign_key_check` reports zero violations before the transaction can commit, and rolls back both DDL and the version marker — with `foreign_keys` restored — on any failure, including a foreign-key violation.

The five guarded rollout database roles (shared, Discord, health, interactive, and worker) use the same schema contract. `scripts/rollout-db.ts` reports version 0 explicitly as `legacy`, accepts only version 1 as current, and rejects future versions. Historical repair logic now lives entirely in `src/db/legacyBaselineMigration.ts` as migration 1, not in `src/db.ts`; `user_version` is authoritative once a database reaches 1, so repairs no longer re-run on every open. Phase 4B (Issue #135) extracted advisor_calls/advisor_attempts and conversation_turns/conversation_summaries direct SQL out of the `BridgeDb` façade into `AdvisorRepository` and `ConversationRepository`; `pending_messages` queue SQL stays in `BridgeDb` — it's tightly coupled to `LockRepository`'s ownership/lease semantics, and extracting it is an explicitly deferred Phase 4C candidate, not yet scoped. `scripts/arch-lint.sh` enforces that advisor/conversation-turn/summary SQL stays confined to its owning repository (or an explicitly marked exception).

## Current schema (from src/db/legacyBaselineMigration.ts DDL)

| Table | Owner (target repository) | Purpose |
|---|---|---|
| bridge_state | sessionRepository / settingsRepository | per-chat sessions, failures, CLI preference |
| settings | settingsRepository | KV: polling offsets, model overrides, cooldowns |
| bridge_runs / bridge_events | runRepository / EventStore | run audit + event log |
| work_items / work_jobs / approvals | workQueueRepository | worker queue + gates |
| github_links | workQueueRepository | issue/PR ↔ work item links |
| feature_plans / work_item_plans | workQueueRepository | plan artifacts |
| prompts | settingsRepository | prompt/skill overrides |
| advisor_calls / advisor_attempts | advisorRepository | advisor reservation, call-limit denial, attempt log |
| conversation_turns / conversation_summaries | conversationRepository | conversation state, /compact source |
| pending_messages | `BridgeDb` (direct — Phase 4C candidate) | execution queue, coupled to `LockRepository` |
| project_memories | memoryRepository | memory store |

## Planned migrations (additive only; better-sqlite3 try/alter pattern already established)

| Version | Status | Purpose |
|---|---|---|
| 0 | legacy | Existing unversioned databases |
| 1 | Phase 4A | Compatibility baseline marker |
| 2+ | future PRs | Individual historical repairs and additive schema changes |

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
