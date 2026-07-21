# 07 — Database & Event Model

## Schema versioning boundary

SQLite `PRAGMA user_version` is the authoritative schema marker. `user_version = 0` denotes the pre-versioned legacy baseline and `CURRENT_SCHEMA_VERSION = 3`. Migration 1 (`applyLegacyCompatibleBaseline`) owns the legacy-compatible DDL and historical repairs. Migration 2 (`dropLegacyPromptOverrides`) removes the absent or empty legacy `prompts` table and aborts without data loss if any unexpected row exists. Migration 3 (`applyRoleAssignmentsMigration`) adds dormant role-assignment revisions and child rows, rejecting pre-existing lookalike tables and validating exact column order, types, nullability, primary keys, defaults, constraints, index membership and sort order, and the cascading foreign key before the transaction advances the version. `openDb()` version-gates before WAL mode or any write; the migration runner applies numbered migrations transactionally, verifies `PRAGMA foreign_key_check`, and rolls back both DDL and the version marker on failure.

The five guarded rollout database roles (shared, Discord, health, interactive, and worker) use the same schema contract. `scripts/rollout-db.ts` reports version 0 as `legacy`, reports exact version 2 as `migratable`, and accepts version 3 as current only when the required role tables have the exact metadata, defaults, constraints, index order, and foreign key and the database-wide `foreign_key_check` is clean; malformed or future schemas fail closed. Historical repair logic remains in migration 1; prompt override retirement is migration 2; dormant role persistence is migration 3; `user_version` is authoritative, so completed migrations do not re-run on open. Phase 4B (Issue #135) extracted advisor_calls/advisor_attempts and conversation_turns/conversation_summaries direct SQL out of the `BridgeDb` façade into `AdvisorRepository` and `ConversationRepository`; `pending_messages` queue SQL stays in `BridgeDb` — it's tightly coupled to `LockRepository`'s ownership/lease semantics, and extracting it is an explicitly deferred Phase 4C candidate, not yet scoped. `scripts/arch-lint.sh` enforces that advisor/conversation-turn/summary SQL stays confined to its owning repository (or an explicitly marked exception).

## Current schema (from src/db/legacyBaselineMigration.ts DDL)

| Table | Owner (target repository) | Purpose |
|---|---|---|
| bridge_state | sessionRepository / settingsRepository | per-chat sessions, failures, CLI preference |
| settings | settingsRepository | KV: polling offsets, model overrides, cooldowns |
| bridge_runs / bridge_events | runRepository / EventStore | run audit + event log |
| work_items / work_jobs / approvals | workQueueRepository | worker queue + gates |
| github_links | workQueueRepository | issue/PR ↔ work item links |
| feature_plans / work_item_plans | workQueueRepository | plan artifacts |
| advisor_calls / advisor_attempts | advisorRepository | advisor reservation, call-limit denial, attempt log |
| conversation_turns / conversation_summaries | conversationRepository | conversation state, /compact source |
| pending_messages | `BridgeDb` (direct — Phase 4C candidate) | execution queue, coupled to `LockRepository` |
| project_memories | memoryRepository | memory store |

## Planned migrations (additive only; better-sqlite3 try/alter pattern already established)

| Version | Status | Purpose |
|---|---|---|
| 0 | legacy | Existing unversioned databases |
| 1 | Phase 4A | Compatibility baseline marker |
| 2 | PR #160 | Remove the empty legacy prompt-override table |
| 3 | Issue #161 / PR #174 | Add dormant role-assignment revisions and child rows |
| 4+ | future PRs | Further additive or explicitly approved schema changes |

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
