/**
 * PURPOSE: SQLite database storage interface and migration definitions for Agent Bridge state.
 * INPUTS: Database file paths, chat IDs, bot types, and session tokens.
 * OUTPUTS: Active session IDs, locks, update indices, and model overrides.
 * NEIGHBORS: src/index.ts, src/bridge.ts
 * LOGIC: Executes DDL schema checks, implements migrations for new columns, and exposes parameterized CRUD operations on the SQLite backend.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { LockRepository } from "./repositories/lockRepository.js";
import { MemoryRepository } from "./repositories/memoryRepository.js";
import { RunRepository } from "./repositories/runRepository.js";
import { SessionRepository } from "./repositories/sessionRepository.js";
import { SettingsRepository } from "./repositories/settingsRepository.js";
import { WorkQueueRepository } from "./repositories/workQueueRepository.js";

// Sentinel row keys stored in bridge_state for non-chat state
const pollingKey = (bot: string) => `$polling:${bot}`;
export const DEFAULT_CONTEXT_MAX_CHARS = 8_000;
export const DEFAULT_CONTEXT_RECENT_TURN_LIMIT = 200;

function recentTurnCandidateLimit(): number {
  const raw = process.env.BRIDGE_CONTEXT_RECENT_TURN_LIMIT;
  if (!raw) return DEFAULT_CONTEXT_RECENT_TURN_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_RECENT_TURN_LIMIT;
}

const MEMORY_SYNONYMS: Record<string, string[]> = {
  affordance: ["helper", "command", "context"],
  compact: ["compact", "compaction", "summary", "summarise", "summarize"],
  compaction: ["compact", "compaction", "summary", "summarise", "summarize"],
  context: ["context", "conversation", "history", "turns"],
  fallback: ["fallback", "switch", "promotion", "persistent", "preference"],
  histories: ["history", "conversation", "context", "turns"],
  history: ["history", "conversation", "context", "turns"],
  memory: ["memory", "memories", "remember", "recall"],
  memories: ["memory", "memories", "remember", "recall"],
  persistent: ["persistent", "preference", "fallback", "promotion"],
  promote: ["promotion", "fallback", "switch", "persistent"],
  promotion: ["promotion", "fallback", "switch", "persistent"],
  summaries: ["summary", "summaries", "summarise", "summarize", "compact", "compaction"],
  summarisation: ["summary", "summaries", "summarise", "summarize", "compact", "compaction"],
  summarization: ["summary", "summaries", "summarise", "summarize", "compact", "compaction"],
  summary: ["summary", "summaries", "summarise", "summarize", "compact", "compaction"],
  switch: ["switch", "fallback", "promotion", "persistent"],
};

function normalizeMemoryTokens(raw: string): string[] {
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const tokens = new Set<string>();
  for (const word of base) {
    tokens.add(word);
    if (word.endsWith("ies") && word.length > 4) tokens.add(`${word.slice(0, -3)}y`);
    if (word.endsWith("s") && word.length > 4) tokens.add(word.slice(0, -1));
    for (const alias of MEMORY_SYNONYMS[word] ?? []) tokens.add(alias);
  }
  return [...tokens].slice(0, 32);
}

export function buildMemoryFtsQuery(raw: string): string {
  return normalizeMemoryTokens(raw).map((w) => `${w}*`).join(" OR ");
}

export function openDb(dbPath: string): BridgeDb {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const raw = new Database(dbPath);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.exec(`
    CREATE TABLE IF NOT EXISTS bridge_state (
      chat_id               TEXT    PRIMARY KEY,
      codex_session_id      TEXT,
      gemini_session_id     TEXT, -- Preserved for legacy session data and backward compatibility
      claude_session_id     TEXT,
      antigravity_session_id TEXT,
      active_execution_lock INTEGER NOT NULL DEFAULT 0,
      last_update_id        INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS bridge_runs (
      run_id             TEXT    PRIMARY KEY,
      chat_id            TEXT    NOT NULL,
      bot                TEXT    NOT NULL,
      status             TEXT    NOT NULL,
      started_at         TEXT    NOT NULL,
      ended_at           TEXT,
      session_id         TEXT,
      final_text_preview TEXT,
      error              TEXT
    );
    CREATE TABLE IF NOT EXISTS bridge_events (
      id                 TEXT    PRIMARY KEY,
      run_id             TEXT    NOT NULL,
      seq                INTEGER NOT NULL,
      type               TEXT    NOT NULL,
      timestamp          TEXT    NOT NULL,
      payload_json       TEXT    NOT NULL,
      FOREIGN KEY(run_id) REFERENCES bridge_runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS work_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL CHECK (kind IN ('defect','feature','maintenance','research','ops','refactor')),
      source      TEXT NOT NULL CHECK (source IN ('telegram','health','defect_scan','refactor_scan','schedule','github','manual')),
      repository  TEXT,
      title       TEXT NOT NULL,
      body        TEXT,
      status      TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','needs_approval','approved','in_progress','blocked','resolved','closed','rejected')),
      priority    TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
      created_by  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS work_jobs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id     INTEGER,
      task_type        TEXT NOT NULL CHECK (task_type IN ('defect_scan','feature_plan','feature_research','implementation_plan','run_tdd_fix','open_github_issue','open_pull_request','verify_pull_request','ops_check','tdd_implementation','orchestrated_task','refactor_scan','pr_lifecycle','pr_watch','pr_refresh')),
      status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','running','waiting_approval','completed','failed','cancelled')),
      bot              TEXT CHECK (bot IN ('codex','antigravity','claude')),
      lease_owner      TEXT,
      lease_expires_at TEXT,
      heartbeat_at     TEXT,
      attempt_count    INTEGER NOT NULL DEFAULT 0,
      max_attempts     INTEGER NOT NULL DEFAULT 2,
      idempotency_key  TEXT NOT NULL UNIQUE,
      input_json       TEXT NOT NULL DEFAULT '{}',
      result_json      TEXT,
      error            TEXT,
      created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(work_item_id) REFERENCES work_items(id)
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id  INTEGER,
      job_id        INTEGER,
      approval_type TEXT NOT NULL CHECK (approval_type IN ('create_issue','start_implementation','push_branch','open_pr','merge_pr','restart_service','cancel_job')),
      status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
      requested_by  TEXT NOT NULL,
      requested_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      decided_by    TEXT,
      decided_at    TEXT,
      expires_at    TEXT,
      payload_json  TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(work_item_id) REFERENCES work_items(id),
      FOREIGN KEY(job_id) REFERENCES work_jobs(id)
    );
    CREATE TABLE IF NOT EXISTS github_links (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id INTEGER NOT NULL,
      repository   TEXT NOT NULL,
      issue_number INTEGER,
      pr_number    INTEGER,
      branch_name  TEXT,
      commit_sha   TEXT,
      remote_url   TEXT,
      created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(repository, issue_number),
      UNIQUE(repository, pr_number),
      FOREIGN KEY(work_item_id) REFERENCES work_items(id)
    );
    CREATE TABLE IF NOT EXISTS feature_plans (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id    TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'drafting' CHECK (status IN ('drafting','ready','accepted','cancelled','expired')),
      brief      TEXT NOT NULL,
      scope_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS work_item_plans (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id INTEGER NOT NULL UNIQUE,
      plan_text    TEXT NOT NULL,
      quality_json TEXT NOT NULL DEFAULT '{}',
      created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(work_item_id) REFERENCES work_items(id)
    );
    CREATE TABLE IF NOT EXISTS prompts (
      name        TEXT    PRIMARY KEY,
      prompt_text TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  try {
    raw.exec(`ALTER TABLE bridge_state ADD COLUMN claude_session_id TEXT`);
  } catch { /* column already exists in existing DBs */ }
  try {
    raw.exec(`ALTER TABLE bridge_state ADD COLUMN antigravity_session_id TEXT`);
  } catch { /* column already exists in existing DBs */ }
  try {
    raw.exec(`UPDATE bridge_state SET antigravity_session_id = gemini_session_id WHERE antigravity_session_id IS NULL AND gemini_session_id IS NOT NULL`);
  } catch { /* ignore migration failures */ }
  try {
    raw.exec(`ALTER TABLE bridge_state ADD COLUMN codex_consecutive_failures INTEGER NOT NULL DEFAULT 0`);
  } catch { /* column already exists */ }
  try {
    raw.exec(`ALTER TABLE bridge_state ADD COLUMN claude_consecutive_failures INTEGER NOT NULL DEFAULT 0`);
  } catch { /* column already exists */ }
  try {
    raw.exec(`ALTER TABLE bridge_state ADD COLUMN antigravity_consecutive_failures INTEGER NOT NULL DEFAULT 0`);
  } catch { /* column already exists */ }
  try {
    raw.exec(`ALTER TABLE bridge_state ADD COLUMN codex_session_created_at TEXT`);
  } catch { /* column already exists */ }
  try {
    raw.exec(`ALTER TABLE bridge_state ADD COLUMN antigravity_session_created_at TEXT`);
  } catch { /* column already exists */ }
  try {
    raw.exec(`ALTER TABLE bridge_state ADD COLUMN claude_session_created_at TEXT`);
  } catch { /* column already exists */ }
  try {
    raw.exec(`ALTER TABLE bridge_state ADD COLUMN kimchi_session_id TEXT`);
  } catch { /* column already exists */ }
  try {
    raw.exec(`ALTER TABLE bridge_state ADD COLUMN kimchi_consecutive_failures INTEGER NOT NULL DEFAULT 0`);
  } catch { /* column already exists */ }
  try {
    raw.exec(`ALTER TABLE bridge_state ADD COLUMN kimchi_session_created_at TEXT`);
  } catch { /* column already exists */ }
  try {
    raw.exec(`ALTER TABLE github_links ADD COLUMN pr_state TEXT NOT NULL DEFAULT 'draft'`);
  } catch { /* column already exists */ }
  try {
    raw.exec(`ALTER TABLE github_links ADD COLUMN last_activity_at TEXT`);
  } catch { /* column already exists */ }
  try {
    raw.exec(`ALTER TABLE github_links ADD COLUMN proof_comment_sha TEXT`);
  } catch { /* column already exists */ }
  try {
    const workItemsSql = (raw.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='work_items'`
    ).get() as { sql: string } | undefined)?.sql ?? "";
    const hasCurrentWorkItemTypes = workItemsSql.includes("'refactor'") && workItemsSql.includes("'refactor_scan'");
    if (!hasCurrentWorkItemTypes) {
      raw.pragma("foreign_keys = OFF");
      raw.pragma("legacy_alter_table = ON");
      try {
        raw.exec(`
          ALTER TABLE work_items RENAME TO work_items_migrate_tmp;
          CREATE TABLE work_items (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            kind        TEXT NOT NULL CHECK (kind IN ('defect','feature','maintenance','research','ops','refactor')),
            source      TEXT NOT NULL CHECK (source IN ('telegram','health','defect_scan','refactor_scan','schedule','github','manual')),
            repository  TEXT,
            title       TEXT NOT NULL,
            body        TEXT,
            status      TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','needs_approval','approved','in_progress','blocked','resolved','closed','rejected')),
            priority    TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
            created_by  TEXT NOT NULL,
            created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          INSERT INTO work_items (id, kind, source, repository, title, body, status, priority, created_by, created_at, updated_at)
          SELECT id, kind, source, repository, title, body, status, priority, created_by, created_at, updated_at
          FROM work_items_migrate_tmp;
          DROP TABLE work_items_migrate_tmp;
        `);
      } finally {
        raw.pragma("legacy_alter_table = OFF");
        raw.pragma("foreign_keys = ON");
      }
    }
  } catch (err) { console.warn('[db] work_items refactor migration failed:', err); }
  // Migrate work_jobs task_type CHECK constraint to include feature_plan, pr_lifecycle,
  // pr_watch, pr_refresh, and orchestrated_task. SQLite cannot ALTER CHECK
  // constraints; use rename-recreate.
  // We disable FK enforcement and legacy-alter-table mode to prevent SQLite 3.26+ from
  // auto-rewriting FK references in other tables (e.g. approvals.job_id) during the
  // rename, which would otherwise cause the DROP TABLE to fail.
  try {
    const workJobsSql = (raw.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='work_jobs'`
    ).get() as { sql: string } | undefined)?.sql ?? "";
    const hasCurrentTaskTypes = workJobsSql.includes("'orchestrated_task'")
      && workJobsSql.includes("'refactor_scan'")
      && workJobsSql.includes("'pr_watch'")
      && workJobsSql.includes("'pr_refresh'");
    if (!hasCurrentTaskTypes) {
      const existingColumns = (raw.prepare(`PRAGMA table_info(work_jobs)`).all() as Array<{ name: string }>)
        .map(c => c.name);
      const hasPhase = existingColumns.includes("phase");
      const hasPhaseData = existingColumns.includes("phase_data_json");
      const baseColumns = [
        "id", "work_item_id", "task_type", "status", "bot", "lease_owner",
        "lease_expires_at", "heartbeat_at", "attempt_count", "max_attempts",
        "idempotency_key", "input_json", "result_json", "error",
        "created_at", "updated_at",
      ];
      const targetColumns = [...baseColumns, "phase", "phase_data_json"].join(", ");
      const sourceColumns = [
        ...baseColumns,
        hasPhase ? "phase" : "'initial'",
        hasPhaseData ? "phase_data_json" : "NULL",
      ].join(", ");
      raw.pragma("foreign_keys = OFF");
      raw.pragma("legacy_alter_table = ON");
      try {
        raw.exec(`
          ALTER TABLE work_jobs RENAME TO work_jobs_migrate_tmp;
          CREATE TABLE work_jobs (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            work_item_id     INTEGER,
            task_type        TEXT NOT NULL CHECK (task_type IN ('defect_scan','feature_plan','feature_research','implementation_plan','run_tdd_fix','open_github_issue','open_pull_request','verify_pull_request','ops_check','tdd_implementation','orchestrated_task','refactor_scan','pr_lifecycle','pr_watch','pr_refresh')),
            status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','running','waiting_approval','completed','failed','cancelled')),
            bot              TEXT CHECK (bot IN ('codex','antigravity','claude')),
            lease_owner      TEXT,
            lease_expires_at TEXT,
            heartbeat_at     TEXT,
            attempt_count    INTEGER NOT NULL DEFAULT 0,
            max_attempts     INTEGER NOT NULL DEFAULT 2,
            idempotency_key  TEXT NOT NULL UNIQUE,
            input_json       TEXT NOT NULL DEFAULT '{}',
            result_json      TEXT,
            error            TEXT,
            created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            phase            TEXT NOT NULL DEFAULT 'initial',
            phase_data_json  TEXT,
            FOREIGN KEY(work_item_id) REFERENCES work_items(id)
          );
          INSERT INTO work_jobs (${targetColumns})
          SELECT ${sourceColumns} FROM work_jobs_migrate_tmp;
          DROP TABLE work_jobs_migrate_tmp;
        `);
      } finally {
        raw.pragma("legacy_alter_table = OFF");
        raw.pragma("foreign_keys = ON");
      }
    }
  } catch (err) { console.warn('[db] work_jobs pr_watch migration failed:', err); }

  // Repair legacy DBs where an earlier work_jobs rename left approvals.job_id
  // pointing at a dropped migration table. That blocks merge approval creation.
  try {
    const approvalsSql = (raw.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='approvals'`
    ).get() as { sql: string } | undefined)?.sql ?? "";
    if (approvalsSql.includes("work_jobs_old") || approvalsSql.includes("work_jobs_migrate_tmp")) {
      raw.pragma("foreign_keys = OFF");
      raw.pragma("legacy_alter_table = ON");
      try {
        raw.exec(`
          ALTER TABLE approvals RENAME TO approvals_migrate_tmp;
          CREATE TABLE approvals (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            work_item_id  INTEGER,
            job_id        INTEGER,
            approval_type TEXT NOT NULL CHECK (approval_type IN ('create_issue','start_implementation','push_branch','open_pr','merge_pr','restart_service','cancel_job')),
            status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
            requested_by  TEXT NOT NULL,
            requested_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            decided_by    TEXT,
            decided_at    TEXT,
            expires_at    TEXT,
            payload_json  TEXT NOT NULL DEFAULT '{}',
            FOREIGN KEY(work_item_id) REFERENCES work_items(id),
            FOREIGN KEY(job_id) REFERENCES work_jobs(id)
          );
          INSERT INTO approvals (
            id, work_item_id, job_id, approval_type, status, requested_by,
            requested_at, decided_by, decided_at, expires_at, payload_json
          )
          SELECT
            id, work_item_id, job_id, approval_type, status, requested_by,
            requested_at, decided_by, decided_at, expires_at, payload_json
          FROM approvals_migrate_tmp;
          DROP TABLE approvals_migrate_tmp;
        `);
      } finally {
        raw.pragma("legacy_alter_table = OFF");
        raw.pragma("foreign_keys = ON");
      }
    }
  } catch (err) { console.warn('[db] approvals FK migration failed:', err); }

  // ── Conversation persistence (2026-06-20) ────────────────────────────────
  // conversation_turns are pruned post-/compact via pruneConvTurns(). Summaries are tiny and kept forever.
  try {
    raw.exec(`
      CREATE TABLE IF NOT EXISTS conversation_turns (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_key   TEXT    NOT NULL,
        role       TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
        text       TEXT    NOT NULL,
        cli        TEXT,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_conv_turns_chat_key ON conversation_turns(chat_key, id);

      CREATE TABLE IF NOT EXISTS pending_messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_key    TEXT    NOT NULL,
        prompt      TEXT    NOT NULL,
        chat_id     INTEGER NOT NULL,
        thread_id   INTEGER,
        chat_type   TEXT    NOT NULL DEFAULT 'private',
        user_id     INTEGER,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_pending_msgs_chat_key ON pending_messages(chat_key, id);

      CREATE TABLE IF NOT EXISTS conversation_summaries (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_key            TEXT    NOT NULL,
        range_start_turn_id INTEGER NOT NULL,
        range_end_turn_id   INTEGER NOT NULL,
        summary_md          TEXT    NOT NULL,
        created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_conv_summaries_chat_key ON conversation_summaries(chat_key, id);
    `);
  } catch { /* tables already exist on upgraded DBs */ }
  raw.exec(`
    DELETE FROM conversation_turns
    WHERE id <= COALESCE((
      SELECT MAX(range_end_turn_id)
      FROM conversation_summaries
      WHERE chat_key = conversation_turns.chat_key
    ), 0)
  `);

  // ── Project memories (2026-06-21) ─────────────────────────────────────────
  try {
    raw.exec(`
      CREATE TABLE IF NOT EXISTS project_memories (
        id              TEXT PRIMARY KEY,
        scope           TEXT NOT NULL DEFAULT 'project',
        type            TEXT NOT NULL DEFAULT 'decision',
        text            TEXT NOT NULL,
        source_chat_key TEXT,
        source_cli      TEXT,
        source_turn_id  INTEGER,
        source_repo_path TEXT,
        confidence      REAL NOT NULL DEFAULT 1.0,
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS project_memories_fts
      USING fts5(id UNINDEXED, text, tokenize='unicode61');
      CREATE TRIGGER IF NOT EXISTS pm_ai AFTER INSERT ON project_memories BEGIN
        INSERT INTO project_memories_fts(rowid, id, text) VALUES (new.rowid, new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS pm_ad AFTER DELETE ON project_memories BEGIN
        INSERT INTO project_memories_fts(project_memories_fts, rowid, id, text) VALUES('delete', old.rowid, old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS pm_au AFTER UPDATE ON project_memories BEGIN
        INSERT INTO project_memories_fts(project_memories_fts, rowid, id, text) VALUES('delete', old.rowid, old.id, old.text);
        INSERT INTO project_memories_fts(rowid, id, text) VALUES (new.rowid, new.id, new.text);
      END;
    `);
  } catch { /* tables already exist on upgraded DBs */ }
  try {
    raw.exec(`ALTER TABLE project_memories ADD COLUMN source_turn_id INTEGER`);
  } catch { /* column already exists */ }
  try {
    raw.exec(`ALTER TABLE project_memories ADD COLUMN source_repo_path TEXT`);
  } catch { /* column already exists */ }

  // ── Job checkpointing (Phase A) ───────────────────────────────────────────
  // Adds phase + phase_data_json to work_jobs so handlers can yield mid-job
  // and resume from a named phase with accumulated state.
  try {
    raw.exec(`ALTER TABLE work_jobs ADD COLUMN phase TEXT NOT NULL DEFAULT 'initial'`);
  } catch { /* column already exists */ }
  try {
    raw.exec(`ALTER TABLE work_jobs ADD COLUMN phase_data_json TEXT`);
  } catch { /* column already exists */ }

  // Clear any locks left held from a previous process that was killed mid-execution
  raw.exec(`UPDATE bridge_state SET active_execution_lock = 0 WHERE active_execution_lock = 1`);
  // Expire sessions older than 7 days — prevents a stale/corrupt session from
  // being resumed indefinitely after a long gap without a /reset
  for (const bot of ["codex", "antigravity", "claude"] as const) {
    raw.exec(
      `UPDATE bridge_state
       SET ${bot}_session_id = NULL, ${bot}_session_created_at = NULL
       WHERE ${bot}_session_created_at IS NOT NULL
         AND ${bot}_session_created_at < datetime('now', '-7 days')`
    );
  }
  return new BridgeDb(raw);
}

export class BridgeDb {
  readonly raw: Database.Database;
  private readonly sessions: SessionRepository;
  private readonly locks: LockRepository;
  private readonly settings: SettingsRepository;
  private readonly runs: RunRepository;
  private readonly workQueue: WorkQueueRepository;
  private readonly memories: MemoryRepository;

  constructor(raw: Database.Database) {
    this.raw = raw;
    this.sessions = new SessionRepository(raw);
    this.locks = new LockRepository(raw);
    this.settings = new SettingsRepository(raw);
    this.runs = new RunRepository(raw);
    this.workQueue = new WorkQueueRepository(raw);
    this.memories = new MemoryRepository(raw);
  }

  // ── Session management ───────────────────────────────────────────────────

  getSession(chatId: string, bot: "codex" | "antigravity" | "claude" | "kimchi"): string | null {
    return this.sessions.getSession(chatId, bot);
  }

  setSession(chatId: string, bot: "codex" | "antigravity" | "claude" | "kimchi", sessionId: string | null): void {
    this.sessions.setSession(chatId, bot, sessionId);
  }

  // ── Per-chat execution lock ──────────────────────────────────────────────

  tryLock(chatId: string): boolean {
    return this.locks.tryLock(chatId);
  }

  unlock(chatId: string): void {
    this.locks.unlock(chatId);
  }

  // ── Global polling offset (per bot kind) ────────────────────────────────

  getLastUpdateId(bot: "codex" | "antigravity" | "claude" | "kimchi"): number {
    return this.settings.getLastUpdateId(bot);
  }

  setLastUpdateId(bot: "codex" | "antigravity" | "claude" | "kimchi", updateId: number): void {
    this.settings.setLastUpdateId(bot, updateId);
  }

  // ── Model-override settings ──────────────────────────────────────────────

  getSetting(key: string): string | null {
    return this.settings.getSetting(key);
  }

  // ── Session failure circuit breaker ─────────────────────────────────────

  incrementFailures(chatId: string, bot: "codex" | "antigravity" | "claude" | "kimchi"): number {
    return this.settings.incrementFailures(chatId, bot);
  }

  resetFailures(chatId: string, bot: "codex" | "antigravity" | "claude" | "kimchi"): void {
    this.settings.resetFailures(chatId, bot);
  }

  getMaxConsecutiveFailures(): { bot: string; count: number }[] {
    return this.settings.getMaxConsecutiveFailures();
  }

  setSetting(key: string, value: string | null): void {
    this.settings.setSetting(key, value);
  }

  getChatRepo(chatId: string): string | null {
    return this.settings.getChatRepo(chatId);
  }

  setChatRepo(chatId: string, repo: string | null): void {
    this.settings.setChatRepo(chatId, repo);
  }

  insertRun(
    runId: string,
    chatId: string,
    bot: string,
  ): void {
    this.runs.insertRun(runId, chatId, bot);
  }

  getRun(runId: string): any {
    return this.runs.getRun(runId);
  }

  updateRunCompleted(runId: string, text: string, sessionId: string | null): void {
    this.runs.updateRunCompleted(runId, text, sessionId);
  }

  updateRunFailed(runId: string, error: string): void {
    this.runs.updateRunFailed(runId, error);
  }

  updateRunCancelled(runId: string, reason: string): void {
    this.runs.updateRunCancelled(runId, reason);
  }

  insertEvent(runId: string, seq: number, type: string, timestamp: string, payload: any): void {
    this.runs.insertEvent(runId, seq, type, timestamp, payload);
  }

  getEventsForRun(runId: string): any[] {
    return this.runs.getEventsForRun(runId);
  }

  // ── Work items ───────────────────────────────────────────────────────────

  createWorkItem(input: {
    kind: string;
    source: string;
    title: string;
    created_by: string;
    repository?: string;
    body?: string;
    priority?: string;
  }): WorkItem {
    return this.workQueue.createWorkItem(input);
  }

  getWorkItem(id: number): WorkItem | null {
    return this.workQueue.getWorkItem(id);
  }

  listWorkItems(filter: { status?: string } = {}): WorkItem[] {
    return this.workQueue.listWorkItems(filter);
  }

  updateWorkItemStatus(id: number, status: string): void {
    this.workQueue.updateWorkItemStatus(id, status);
  }

  updateWorkItemBody(id: number, body: string): void {
    this.workQueue.updateWorkItemBody(id, body);
  }

  updateWorkItemTitleAndBody(id: number, title: string, body: string | null): void {
    this.workQueue.updateWorkItemTitleAndBody(id, title, body);
  }

  // ── Work jobs ────────────────────────────────────────────────────────────

  createWorkJob(input: {
    task_type: string;
    idempotency_key: string;
    work_item_id?: number | null;
    bot?: string;
    input_json?: object;
    max_attempts?: number;
  }): WorkJob {
    return this.workQueue.createWorkJob(input);
  }

  getWorkJob(id: number): WorkJob | null {
    return this.workQueue.getWorkJob(id);
  }

  listWorkJobs(filter: { status?: string } = {}): WorkJob[] {
    return this.workQueue.listWorkJobs(filter);
  }

  // ── Job lease lifecycle ──────────────────────────────────────────────────

  claimNextWorkJob(workerId: string, now: string, leaseSeconds: number, jobId?: number): WorkJob | null {
    return this.workQueue.claimNextWorkJob(workerId, now, leaseSeconds, jobId);
  }

  markWorkJobRunning(jobId: number, workerId: string): void {
    this.workQueue.markWorkJobRunning(jobId, workerId);
  }

  heartbeatWorkJob(jobId: number, workerId: string, now: string, leaseSeconds?: number): void {
    this.workQueue.heartbeatWorkJob(jobId, workerId, now, leaseSeconds);
  }

  completeWorkJob(jobId: number, result: object, workerId: string): void {
    this.workQueue.completeWorkJob(jobId, result, workerId);
  }

  failWorkJob(jobId: number, error: string, workerId: string): void {
    this.workQueue.failWorkJob(jobId, error, workerId);
  }

  failWorkJobPermanently(jobId: number, error: string, workerId: string): void {
    this.workQueue.failWorkJobPermanently(jobId, error, workerId);
  }

  /** Re-queue a job as pending with an updated phase and phaseData checkpoint. */
  continueWorkJob(jobId: number, phase: string, phaseData: object, workerId: string): void {
    this.workQueue.continueWorkJob(jobId, phase, phaseData, workerId);
  }

  recoverExpiredWorkJobs(now: string): number {
    return this.workQueue.recoverExpiredWorkJobs(now);
  }

  cancelWorkJob(jobId: number, _reason: string): void {
    this.workQueue.cancelWorkJob(jobId, _reason);
  }

  // ── Approvals ────────────────────────────────────────────────────────────

  createApproval(input: {
    approval_type: string;
    requested_by: string;
    work_item_id?: number | null;
    job_id?: number | null;
    expires_at?: string | null;
    payload?: object;
  }): Approval {
    return this.workQueue.createApproval(input);
  }

  resolveApproval(id: number, decision: "approved" | "rejected", decidedBy: string, now: string = new Date().toISOString()): Approval {
    return this.workQueue.resolveApproval(id, decision, decidedBy, now);
  }

  // ── GitHub links ─────────────────────────────────────────────────────────

  linkGithubIssue(input: { work_item_id: number; repository: string; issue_number: number }): GithubLink {
    return this.workQueue.linkGithubIssue(input);
  }

  getGithubIssueLink(repository: string, issueNumber: number): GithubLink | null {
    return this.workQueue.getGithubIssueLink(repository, issueNumber);
  }

  linkGithubPr(input: { work_item_id: number; repository: string; pr_number: number; branch_name?: string; commit_sha?: string }): GithubLink {
    return this.workQueue.linkGithubPr(input);
  }

  updatePrState(linkId: number, state: string): void {
    this.workQueue.updatePrState(linkId, state);
  }

  listOpenAgentPrs(repository: string): GithubLink[] {
    return this.workQueue.listOpenAgentPrs(repository);
  }

  listAllOpenAgentPrs(): GithubLink[] {
    return this.workQueue.listAllOpenAgentPrs();
  }

  touchPrActivity(linkId: number, ts: string): void {
    this.workQueue.touchPrActivity(linkId, ts);
  }

  setProofCommentSha(linkId: number, sha: string): void {
    this.workQueue.setProofCommentSha(linkId, sha);
  }

  countDailyAgentPrs(repository: string): number {
    return this.workQueue.countDailyAgentPrs(repository);
  }

  // ── Feature plans ────────────────────────────────────────────────────────

  createFeaturePlan(input: { chatId: string; userId: string; brief: string }): FeaturePlan {
    const { chatId, userId, brief } = input;
    // Cancel any existing drafting plan for this chat before creating a new one
    this.raw.prepare(
      `UPDATE feature_plans SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
       WHERE chat_id = ? AND status = 'drafting'`
    ).run(chatId);
    return this.raw.prepare(
      `INSERT INTO feature_plans (chat_id, user_id, brief) VALUES (?, ?, ?) RETURNING *`
    ).get(chatId, userId, brief) as FeaturePlan;
  }

  getFeaturePlan(id: number): FeaturePlan | null {
    return (this.raw.prepare(`SELECT * FROM feature_plans WHERE id = ?`).get(id) as FeaturePlan | undefined) ?? null;
  }

  getActivePlanForChat(chatId: string): FeaturePlan | null {
    return (this.raw.prepare(
      `SELECT * FROM feature_plans WHERE chat_id = ? AND status = 'drafting' ORDER BY id DESC LIMIT 1`
    ).get(chatId) as FeaturePlan | undefined) ?? null;
  }

  updateFeaturePlanStatus(id: number, status: string): void {
    this.raw.prepare(
      `UPDATE feature_plans SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(status, id);
  }

  updateFeaturePlanScope(id: number, scope: object): void {
    this.raw.prepare(
      `UPDATE feature_plans SET scope_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(JSON.stringify(scope), id);
  }

  setWorkItemPlan(workItemId: number, planText: string, quality: object = {}): WorkItemPlan {
    return this.raw.prepare(
      `INSERT INTO work_item_plans (work_item_id, plan_text, quality_json)
       VALUES (?, ?, ?)
       ON CONFLICT(work_item_id) DO UPDATE SET
         plan_text = excluded.plan_text,
         quality_json = excluded.quality_json,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`
    ).get(workItemId, planText, JSON.stringify(quality)) as WorkItemPlan;
  }

  getWorkItemPlan(workItemId: number): WorkItemPlan | null {
    return (this.raw.prepare(
      `SELECT * FROM work_item_plans WHERE work_item_id = ? LIMIT 1`
    ).get(workItemId) as WorkItemPlan | undefined) ?? null;
  }

  cleanupOrphanedRuns(onOrphan: (run: { run_id: string; chat_id: string; bot: string }) => void | Promise<void>): void {
    this.runs.cleanupOrphanedRuns(onOrphan);
  }

  // ── Conversation turns ──────────────────────────────────────────────────
  addConvTurn(chatKey: string, role: "user" | "assistant", text: string, cli?: string): void {
    this.raw
      .prepare(`INSERT INTO conversation_turns (chat_key, role, text, cli) VALUES (?, ?, ?, ?)`)
      .run(chatKey, role, text, cli ?? null);
  }

  getRecentConvTurns(
    chatKey: string,
    limit: number,
    sinceId?: number,
  ): Array<{ id: number; role: string; text: string; cli: string | null; created_at: string }> {
    if (sinceId != null) {
      // Fetch the newest `limit` turns after sinceId (not the oldest), then
      // re-sort chronologically — mirrors the no-summary branch below so the
      // most recent context is never silently dropped once a chat exceeds
      // the candidate limit.
      return this.raw
        .prepare(
          `SELECT id, role, text, cli, created_at FROM (
             SELECT id, role, text, cli, created_at FROM conversation_turns
             WHERE chat_key = ? AND id > ?
             ORDER BY id DESC LIMIT ?
           ) ORDER BY id ASC`
        )
        .all(chatKey, sinceId, limit) as any;
    }
    return this.raw
      .prepare(
        `SELECT id, role, text, cli, created_at FROM (
           SELECT id, role, text, cli, created_at FROM conversation_turns
           WHERE chat_key = ?
           ORDER BY id DESC LIMIT ?
         ) ORDER BY id ASC`
      )
      .all(chatKey, limit) as any;
  }

  buildConvContext(chatKey: string, maxChars = DEFAULT_CONTEXT_MAX_CHARS): string {
    const summary = this.getLatestConvSummary(chatKey);
    const sinceId = summary?.range_end_turn_id;
    // Fetch the newest N candidates (configurable via BRIDGE_CONTEXT_RECENT_TURN_LIMIT);
    // char budget below further culls them. This is a prompt-context cap only —
    // compaction (getConvTurnsForCompaction) always processes the full backlog.
    const candidates = this.getRecentConvTurns(chatKey, recentTurnCandidateLimit(), sinceId);
    if (!summary && candidates.length === 0) return "";

    // Walk newest-first, accumulate until char budget is exhausted
    let budget = maxChars - (summary ? summary.summary_md.length : 0);
    const selected: Array<{ role: string; text: string }> = [];
    for (let i = candidates.length - 1; i >= 0; i--) {
      const t = candidates[i];
      const line = `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`;
      if (line.length <= budget) {
        selected.unshift({ role: t.role, text: t.text });
        budget -= line.length;
      }
    }

    const lines = ["[Context from previous conversation]"];
    if (summary) {
      lines.push(summary.summary_md);
      lines.push("");
    }
    for (const t of selected) {
      lines.push(`${t.role === "user" ? "User" : "Assistant"}: ${t.text}`);
    }
    lines.push("[End context — continue naturally]");
    return lines.join("\n") + "\n\n";
  }

  // ── Pending messages ────────────────────────────────────────────────────
  pendingMsgCount(chatKey: string): number {
    const row = this.raw
      .prepare(`SELECT COUNT(*) AS n FROM pending_messages WHERE chat_key = ?`)
      .get(chatKey) as { n: number };
    return row.n;
  }

  enqueueMsg(
    chatKey: string,
    msg: { prompt: string; chatId: number; threadId?: number; chatType: string; userId?: number },
  ): void {
    this.raw
      .prepare(
        `INSERT INTO pending_messages (chat_key, prompt, chat_id, thread_id, chat_type, user_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(chatKey, msg.prompt, msg.chatId, msg.threadId ?? null, msg.chatType, msg.userId ?? null);
  }

  dequeueMsgs(chatKey: string): Array<{
    id: number; prompt: string; chatId: number; threadId: number | null; chatType: string; userId: number | null;
  }> {
    return (this.raw
      .prepare(`SELECT id, prompt, chat_id AS chatId, thread_id AS threadId, chat_type AS chatType, user_id AS userId
                FROM pending_messages WHERE chat_key = ? ORDER BY id ASC`)
      .all(chatKey) as any);
  }

  deletePendingMsg(id: number): void {
    this.raw.prepare(`DELETE FROM pending_messages WHERE id = ?`).run(id);
  }

  // ── Conversation summaries ──────────────────────────────────────────────
  addConvSummary(chatKey: string, startTurnId: number, endTurnId: number, summaryMd: string): void {
    this.raw
      .prepare(
        `INSERT INTO conversation_summaries (chat_key, range_start_turn_id, range_end_turn_id, summary_md)
         VALUES (?, ?, ?, ?)`
      )
      .run(chatKey, startTurnId, endTurnId, summaryMd);
  }

  getLatestConvSummary(chatKey: string): {
    id: number; range_start_turn_id: number; range_end_turn_id: number; summary_md: string; created_at: string;
  } | null {
    return (this.raw
      .prepare(
        `SELECT id, range_start_turn_id, range_end_turn_id, summary_md, created_at
         FROM conversation_summaries WHERE chat_key = ? ORDER BY id DESC LIMIT 1`
      )
      .get(chatKey) as any) ?? null;
  }

  getConvTurnsForCompaction(chatKey: string): Array<{ id: number; role: string; text: string; cli: string | null; created_at: string }> {
    const summary = this.getLatestConvSummary(chatKey);
    return this.raw
      .prepare(
        `SELECT id, role, text, cli, created_at FROM conversation_turns
         WHERE chat_key = ? AND id > ?
         ORDER BY id ASC`
      )
      .all(chatKey, summary?.range_end_turn_id ?? 0) as any;
  }

  getUncompactedConvStats(chatKey: string): { turnCount: number; charCount: number } {
    const summary = this.getLatestConvSummary(chatKey);
    return this.raw
      .prepare(
        `SELECT COUNT(*) AS turnCount, COALESCE(SUM(LENGTH(text)), 0) AS charCount
         FROM conversation_turns WHERE chat_key = ? AND id > ?`
      )
      .get(chatKey, summary?.range_end_turn_id ?? 0) as { turnCount: number; charCount: number };
  }

  pruneConvTurns(chatKey: string, upToTurnId: number): void {
    this.raw
      .prepare(`DELETE FROM conversation_turns WHERE chat_key = ? AND id <= ?`)
      .run(chatKey, upToTurnId);
  }

  clearConvHistory(chatKey: string): void {
    this.raw.prepare(`DELETE FROM conversation_turns WHERE chat_key = ?`).run(chatKey);
    this.raw.prepare(`DELETE FROM conversation_summaries WHERE chat_key = ?`).run(chatKey);
  }

  getConvStatus(chatKey: string): {
    turnCount: number; pendingCount: number; latestSummaryAt: string | null; latestTurnAt: string | null;
  } {
    const tc = this.raw
      .prepare(`SELECT COUNT(*) AS n FROM conversation_turns WHERE chat_key = ?`)
      .get(chatKey) as { n: number };
    const pc = this.raw
      .prepare(`SELECT COUNT(*) AS n FROM pending_messages WHERE chat_key = ?`)
      .get(chatKey) as { n: number };
    const lt = this.raw
      .prepare(`SELECT created_at FROM conversation_turns WHERE chat_key = ? ORDER BY id DESC LIMIT 1`)
      .get(chatKey) as { created_at: string } | undefined;
    const ls = this.raw
      .prepare(`SELECT created_at FROM conversation_summaries WHERE chat_key = ? ORDER BY id DESC LIMIT 1`)
      .get(chatKey) as { created_at: string } | undefined;
    return {
      turnCount: tc.n,
      pendingCount: pc.n,
      latestSummaryAt: ls?.created_at ?? null,
      latestTurnAt: lt?.created_at ?? null,
    };
  }

  // ── Project memory ────────────────────────────────────────────────────────

  addMemory(mem: { id: string; type: string; scope?: string; text: string; source_chat_key?: string; source_cli?: string; source_turn_id?: number; source_repo_path?: string; confidence?: number }): void {
    this.memories.addMemory(mem);
  }

  findMemoryByText(text: string): { id: string } | null {
    return this.memories.findMemoryByText(text);
  }

  getLatestConvTurnId(chatKey: string): number | null {
    return this.memories.getLatestConvTurnId(chatKey);
  }

  searchMemories(query: string, limit = 5, chatKey?: string): Array<{ id: string; type: string; text: string; score: number; snippet: string }> {
    return chatKey === undefined
      ? this.memories.searchMemories(query, limit)
      : this.memories.searchMemories(query, limit, chatKey);
  }

  getMemoryCount(): number {
    return this.memories.getMemoryCount();
  }

  getPrompt(name: string, fallback: string): string {
    const row = this.raw.prepare("SELECT prompt_text FROM prompts WHERE name = ?").get(name) as { prompt_text: string } | undefined;
    return row ? row.prompt_text : fallback;
  }

  setPrompt(name: string, promptText: string): void {
    this.raw.prepare(
      `INSERT INTO prompts (name, prompt_text)
       VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET
         prompt_text = excluded.prompt_text,
         updated_at = CURRENT_TIMESTAMP`
    ).run(name, promptText);
  }

  close(): void {
    this.raw.close();
  }
}

// ── Domain types ─────────────────────────────────────────────────────────────

export interface WorkItem {
  id: number;
  kind: string;
  source: string;
  repository: string | null;
  title: string;
  body: string | null;
  status: string;
  priority: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface WorkJob {
  id: number;
  work_item_id: number | null;
  task_type: string;
  status: string;
  bot: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  attempt_count: number;
  max_attempts: number;
  idempotency_key: string;
  input_json: string;
  result_json: string | null;
  error: string | null;
  phase: string;
  phase_data_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface Approval {
  id: number;
  work_item_id: number | null;
  job_id: number | null;
  approval_type: string;
  status: string;
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  expires_at: string | null;
  payload_json: string;
}

export interface GithubLink {
  id: number;
  work_item_id: number;
  repository: string;
  issue_number: number | null;
  pr_number: number | null;
  branch_name: string | null;
  commit_sha: string | null;
  remote_url: string | null;
  pr_state: string;
  last_activity_at: string | null;
  proof_comment_sha: string | null;
  created_at: string;
  updated_at: string;
}

export interface FeaturePlan {
  id: number;
  chat_id: string;
  user_id: string;
  status: string;
  brief: string;
  scope_json: string;
  created_at: string;
  updated_at: string;
}

export interface WorkItemPlan {
  id: number;
  work_item_id: number;
  plan_text: string;
  quality_json: string;
  created_at: string;
  updated_at: string;
}
