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

// Sentinel row keys stored in bridge_state for non-chat state
const pollingKey = (bot: string) => `$polling:${bot}`;

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
      kind        TEXT NOT NULL CHECK (kind IN ('defect','feature','maintenance','research','ops')),
      source      TEXT NOT NULL CHECK (source IN ('telegram','health','defect_scan','schedule','github','manual')),
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
      task_type        TEXT NOT NULL CHECK (task_type IN ('defect_scan','feature_plan','feature_research','implementation_plan','run_tdd_fix','open_github_issue','open_pull_request','verify_pull_request','ops_check','tdd_implementation','pr_lifecycle')),
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
    raw.exec(`ALTER TABLE github_links ADD COLUMN pr_state TEXT NOT NULL DEFAULT 'draft'`);
  } catch { /* column already exists */ }
  try {
    raw.exec(`ALTER TABLE github_links ADD COLUMN last_activity_at TEXT`);
  } catch { /* column already exists */ }
  try {
    raw.exec(`ALTER TABLE github_links ADD COLUMN proof_comment_sha TEXT`);
  } catch { /* column already exists */ }
  // Migrate work_jobs task_type CHECK constraint to include feature_plan, pr_lifecycle,
  // pr_watch, and pr_refresh. SQLite cannot ALTER CHECK constraints; use rename-recreate.
  // We disable FK enforcement and legacy-alter-table mode to prevent SQLite 3.26+ from
  // auto-rewriting FK references in other tables (e.g. approvals.job_id) during the
  // rename, which would otherwise cause the DROP TABLE to fail.
  try {
    const hasPrWatch = (raw.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='work_jobs'`
    ).get() as { sql: string } | undefined)?.sql?.includes("'pr_watch'");
    if (!hasPrWatch) {
      raw.pragma("foreign_keys = OFF");
      raw.pragma("legacy_alter_table = ON");
      try {
        raw.exec(`
          ALTER TABLE work_jobs RENAME TO work_jobs_migrate_tmp;
          CREATE TABLE work_jobs (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            work_item_id     INTEGER,
            task_type        TEXT NOT NULL CHECK (task_type IN ('defect_scan','feature_plan','feature_research','implementation_plan','run_tdd_fix','open_github_issue','open_pull_request','verify_pull_request','ops_check','tdd_implementation','pr_lifecycle','pr_watch','pr_refresh')),
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
          INSERT INTO work_jobs SELECT * FROM work_jobs_migrate_tmp;
          DROP TABLE work_jobs_migrate_tmp;
        `);
      } finally {
        raw.pragma("legacy_alter_table = OFF");
        raw.pragma("foreign_keys = ON");
      }
    }
  } catch (err) { console.warn('[db] work_jobs pr_watch migration failed:', err); }

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

  constructor(raw: Database.Database) {
    this.raw = raw;
  }

  // ── Session management ───────────────────────────────────────────────────

  getSession(chatId: string, bot: "codex" | "antigravity" | "claude"): string | null {
    if (bot !== "codex" && bot !== "antigravity" && bot !== "claude") throw new Error(`Invalid bot kind: ${bot}`);
    const col = `${bot}_session_id`;
    const row = this.raw
      .prepare(`SELECT ${col} AS sid FROM bridge_state WHERE chat_id = ?`)
      .get(chatId) as { sid: string | null } | undefined;
    return row?.sid ?? null;
  }

  setSession(chatId: string, bot: "codex" | "antigravity" | "claude", sessionId: string | null): void {
    if (bot !== "codex" && bot !== "antigravity" && bot !== "claude") throw new Error(`Invalid bot kind: ${bot}`);
    const col = `${bot}_session_id`;
    const tsCol = `${bot}_session_created_at`;
    // Record when a new session is first stored; clear timestamp when session is cleared
    const ts = sessionId !== null ? new Date().toISOString() : null;
    this.raw
      .prepare(
        `INSERT INTO bridge_state (chat_id, ${col}, ${tsCol}) VALUES (?, ?, ?)
         ON CONFLICT (chat_id) DO UPDATE SET ${col} = excluded.${col}, ${tsCol} = CASE
           WHEN excluded.${col} IS NULL THEN NULL
           WHEN ${col} IS NULL OR ${col} != excluded.${col} THEN excluded.${tsCol}
           ELSE ${tsCol}
         END`
      )
      .run(chatId, sessionId, ts);
  }

  // ── Per-chat execution lock ──────────────────────────────────────────────

  tryLock(chatId: string): boolean {
    // Ensure the row exists before updating
    this.raw
      .prepare(`INSERT INTO bridge_state (chat_id) VALUES (?) ON CONFLICT (chat_id) DO NOTHING`)
      .run(chatId);
    // Atomically claim the lock only when it is free
    const { changes } = this.raw
      .prepare(
        `UPDATE bridge_state SET active_execution_lock = 1
         WHERE chat_id = ? AND active_execution_lock = 0`
      )
      .run(chatId);
    return changes === 1;
  }

  unlock(chatId: string): void {
    this.raw
      .prepare(`UPDATE bridge_state SET active_execution_lock = 0 WHERE chat_id = ?`)
      .run(chatId);
  }

  // ── Global polling offset (per bot kind) ────────────────────────────────

  getLastUpdateId(bot: "codex" | "antigravity" | "claude"): number {
    const row = this.raw
      .prepare(`SELECT last_update_id FROM bridge_state WHERE chat_id = ?`)
      .get(pollingKey(bot)) as { last_update_id: number } | undefined;
    return row?.last_update_id ?? 0;
  }

  setLastUpdateId(bot: "codex" | "antigravity" | "claude", updateId: number): void {
    this.raw
      .prepare(
        `INSERT INTO bridge_state (chat_id, last_update_id) VALUES (?, ?)
         ON CONFLICT (chat_id) DO UPDATE SET
           last_update_id = MAX(last_update_id, excluded.last_update_id)`
      )
      .run(pollingKey(bot), updateId);
  }

  // ── Model-override settings ──────────────────────────────────────────────

  getSetting(key: string): string | null {
    const row = this.raw
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get(key) as { value: string | null } | undefined;
    return row?.value ?? null;
  }

  // ── Session failure circuit breaker ─────────────────────────────────────

  incrementFailures(chatId: string, bot: "codex" | "antigravity" | "claude"): number {
    const col = `${bot}_consecutive_failures`;
    this.raw
      .prepare(
        `INSERT INTO bridge_state (chat_id, ${col}) VALUES (?, 1)
         ON CONFLICT (chat_id) DO UPDATE SET ${col} = ${col} + 1`
      )
      .run(chatId);
    const row = this.raw
      .prepare(`SELECT ${col} AS n FROM bridge_state WHERE chat_id = ?`)
      .get(chatId) as { n: number } | undefined;
    return row?.n ?? 1;
  }

  resetFailures(chatId: string, bot: "codex" | "antigravity" | "claude"): void {
    const col = `${bot}_consecutive_failures`;
    this.raw
      .prepare(`UPDATE bridge_state SET ${col} = 0 WHERE chat_id = ?`)
      .run(chatId);
  }

  getMaxConsecutiveFailures(): { bot: string; count: number }[] {
    const row = this.raw
      .prepare(
        `SELECT MAX(codex_consecutive_failures) AS codex,
                MAX(claude_consecutive_failures) AS claude,
                MAX(antigravity_consecutive_failures) AS antigravity
         FROM bridge_state`
      )
      .get() as { codex: number; claude: number; antigravity: number } | undefined;
    if (!row) return [];
    const results: { bot: string; count: number }[] = [];
    if (row.codex > 0) results.push({ bot: "codex", count: row.codex });
    if (row.claude > 0) results.push({ bot: "claude", count: row.claude });
    if (row.antigravity > 0) results.push({ bot: "antigravity", count: row.antigravity });
    return results;
  }

  setSetting(key: string, value: string | null): void {
    this.raw
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }

  insertRun(
    runId: string,
    chatId: string,
    bot: string,
  ): void {
    const startedAt = new Date().toISOString();
    this.raw
      .prepare(
        `INSERT INTO bridge_runs (run_id, chat_id, bot, status, started_at)
         VALUES (?, ?, ?, 'running', ?)`
      )
      .run(runId, chatId, bot, startedAt);
  }

  getRun(runId: string): any {
    return this.raw
      .prepare(`SELECT * FROM bridge_runs WHERE run_id = ?`)
      .get(runId);
  }

  updateRunCompleted(runId: string, text: string, sessionId: string | null): void {
    const endedAt = new Date().toISOString();
    this.raw
      .prepare(
        `UPDATE bridge_runs
         SET status = 'done', ended_at = ?, final_text_preview = ?, session_id = ?
         WHERE run_id = ?`
      )
      .run(endedAt, text, sessionId, runId);
  }

  updateRunFailed(runId: string, error: string): void {
    const endedAt = new Date().toISOString();
    this.raw
      .prepare(
        `UPDATE bridge_runs
         SET status = 'failed', ended_at = ?, error = ?
         WHERE run_id = ?`
      )
      .run(endedAt, error, runId);
  }

  updateRunCancelled(runId: string, reason: string): void {
    const endedAt = new Date().toISOString();
    this.raw
      .prepare(
        `UPDATE bridge_runs
         SET status = 'cancelled', ended_at = ?
         WHERE run_id = ?`
      )
      .run(endedAt, runId);
  }

  insertEvent(runId: string, seq: number, type: string, timestamp: string, payload: any): void {
    const id = `${runId}:${seq}`;
    const payloadJson = JSON.stringify(payload);
    this.raw
      .prepare(
        `INSERT INTO bridge_events (id, run_id, seq, type, timestamp, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, runId, seq, type, timestamp, payloadJson);
  }

  getEventsForRun(runId: string): any[] {
    return this.raw
      .prepare(`SELECT * FROM bridge_events WHERE run_id = ? ORDER BY seq ASC`)
      .all(runId);
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
    const { kind, source, title, created_by, repository = null, body = null, priority = "normal" } = input;
    const stmt = this.raw.prepare(
      `INSERT INTO work_items (kind, source, title, created_by, repository, body, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    );
    return stmt.get(kind, source, title, created_by, repository, body, priority) as WorkItem;
  }

  getWorkItem(id: number): WorkItem | null {
    return (this.raw.prepare(`SELECT * FROM work_items WHERE id = ?`).get(id) as WorkItem | undefined) ?? null;
  }

  listWorkItems(filter: { status?: string } = {}): WorkItem[] {
    if (filter.status) {
      return this.raw.prepare(`SELECT * FROM work_items WHERE status = ? ORDER BY id ASC`).all(filter.status) as WorkItem[];
    }
    return this.raw.prepare(`SELECT * FROM work_items ORDER BY id ASC`).all() as WorkItem[];
  }

  updateWorkItemStatus(id: number, status: string): void {
    this.raw.prepare(
      `UPDATE work_items SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(status, id);
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
    const { task_type, idempotency_key, work_item_id = null, bot = null, input_json = {}, max_attempts = 2 } = input;
    // Return existing job if idempotency key already exists
    const existing = this.raw.prepare(`SELECT * FROM work_jobs WHERE idempotency_key = ?`).get(idempotency_key) as WorkJob | undefined;
    if (existing) return existing;
    const stmt = this.raw.prepare(
      `INSERT INTO work_jobs (task_type, idempotency_key, work_item_id, bot, input_json, max_attempts)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`
    );
    return stmt.get(task_type, idempotency_key, work_item_id, bot, JSON.stringify(input_json), max_attempts) as WorkJob;
  }

  getWorkJob(id: number): WorkJob | null {
    return (this.raw.prepare(`SELECT * FROM work_jobs WHERE id = ?`).get(id) as WorkJob | undefined) ?? null;
  }

  listWorkJobs(filter: { status?: string } = {}): WorkJob[] {
    if (filter.status) {
      return this.raw.prepare(`SELECT * FROM work_jobs WHERE status = ? ORDER BY id ASC`).all(filter.status) as WorkJob[];
    }
    return this.raw.prepare(`SELECT * FROM work_jobs ORDER BY id ASC`).all() as WorkJob[];
  }

  // ── Job lease lifecycle ──────────────────────────────────────────────────

  claimNextWorkJob(workerId: string, now: string, leaseSeconds: number, jobId?: number): WorkJob | null {
    const expiresAt = new Date(new Date(now).getTime() + leaseSeconds * 1000).toISOString();
    const job = jobId != null
      ? this.raw.prepare(
          `SELECT * FROM work_jobs
           WHERE id = ?
             AND (status = 'pending' OR (status IN ('leased','running') AND lease_expires_at < ?))`
        ).get(jobId, now) as WorkJob | undefined
      : this.raw.prepare(
          `SELECT * FROM work_jobs
           WHERE status = 'pending'
              OR (status IN ('leased','running') AND lease_expires_at < ?)
           ORDER BY created_at ASC, id ASC
           LIMIT 1`
        ).get(now) as WorkJob | undefined;
    if (!job) return null;
    const { changes } = this.raw.prepare(
      `UPDATE work_jobs
       SET status = 'leased', lease_owner = ?, lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND (status = 'pending' OR (status IN ('leased','running') AND lease_expires_at < ?))`
    ).run(workerId, expiresAt, job.id, now);
    if (changes === 0) return null;
    return this.raw.prepare(`SELECT * FROM work_jobs WHERE id = ?`).get(job.id) as WorkJob;
  }

  markWorkJobRunning(jobId: number, workerId: string): void {
    this.raw.prepare(
      `UPDATE work_jobs SET status = 'running', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND lease_owner = ? AND status = 'leased'`
    ).run(jobId, workerId);
  }

  heartbeatWorkJob(jobId: number, workerId: string, now: string, leaseSeconds?: number): void {
    if (leaseSeconds != null) {
      const expiresAt = new Date(new Date(now).getTime() + leaseSeconds * 1000).toISOString();
      this.raw.prepare(
        `UPDATE work_jobs SET heartbeat_at = ?, lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND lease_owner = ?`
      ).run(now, expiresAt, jobId, workerId);
      return;
    }
    this.raw.prepare(
      `UPDATE work_jobs SET heartbeat_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND lease_owner = ?`
    ).run(now, jobId, workerId);
  }

  completeWorkJob(jobId: number, result: object, workerId: string): void {
    this.raw.prepare(
      `UPDATE work_jobs
       SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
           result_json = ?, error = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND lease_owner = ? AND status != 'cancelled'`
    ).run(JSON.stringify(result), jobId, workerId);
  }

  failWorkJob(jobId: number, error: string, workerId: string): void {
    this.raw.prepare(
      `UPDATE work_jobs
       SET attempt_count = attempt_count + 1,
           status = CASE WHEN attempt_count + 1 < max_attempts THEN 'pending' ELSE 'failed' END,
           error = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND lease_owner = ? AND status != 'cancelled'`
    ).run(error, jobId, workerId);
  }

  failWorkJobPermanently(jobId: number, error: string, workerId: string): void {
    this.raw.prepare(
      `UPDATE work_jobs
       SET status = 'failed', error = ?, lease_owner = NULL, lease_expires_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND lease_owner = ? AND status != 'cancelled'`
    ).run(error, jobId, workerId);
  }

  recoverExpiredWorkJobs(now: string): number {
    const { changes } = this.raw.prepare(
      `UPDATE work_jobs
       SET status = CASE WHEN attempt_count < max_attempts THEN 'pending' ELSE 'failed' END,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE status IN ('leased','running') AND lease_expires_at < ?`
    ).run(now);
    return changes;
  }

  cancelWorkJob(jobId: number, _reason: string): void {
    this.raw.prepare(
      `UPDATE work_jobs SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(jobId);
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
    const { approval_type, requested_by, work_item_id = null, job_id = null, expires_at = null, payload = {} } = input;
    const stmt = this.raw.prepare(
      `INSERT INTO approvals (approval_type, requested_by, work_item_id, job_id, expires_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`
    );
    return stmt.get(approval_type, requested_by, work_item_id, job_id, expires_at, JSON.stringify(payload)) as Approval;
  }

  resolveApproval(id: number, decision: "approved" | "rejected", decidedBy: string, now: string = new Date().toISOString()): Approval {
    // First mark any pending approvals that have passed expires_at as expired
    this.raw.prepare(
      `UPDATE approvals SET status = 'expired'
       WHERE id = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`
    ).run(id, now);
    // Only update if still pending and not expired — first decision sticks
    this.raw.prepare(
      `UPDATE approvals
       SET status = ?, decided_by = ?, decided_at = ?
       WHERE id = ? AND status = 'pending'`
    ).run(decision, decidedBy, now, id);
    return this.raw.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as Approval;
  }

  // ── GitHub links ─────────────────────────────────────────────────────────

  linkGithubIssue(input: { work_item_id: number; repository: string; issue_number: number }): GithubLink {
    const { work_item_id, repository, issue_number } = input;
    return this.raw.prepare(
      `INSERT INTO github_links (work_item_id, repository, issue_number)
       VALUES (?, ?, ?)
       RETURNING *`
    ).get(work_item_id, repository, issue_number) as GithubLink;
  }

  linkGithubPr(input: { work_item_id: number; repository: string; pr_number: number; branch_name?: string; commit_sha?: string }): GithubLink {
    const { work_item_id, repository, pr_number, branch_name = null, commit_sha = null } = input;
    return this.raw.prepare(
      `INSERT INTO github_links (work_item_id, repository, pr_number, branch_name, commit_sha)
       VALUES (?, ?, ?, ?, ?)
       RETURNING *`
    ).get(work_item_id, repository, pr_number, branch_name, commit_sha) as GithubLink;
  }

  updatePrState(linkId: number, state: string): void {
    this.raw.prepare(
      `UPDATE github_links SET pr_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(state, linkId);
  }

  listOpenAgentPrs(repository: string): GithubLink[] {
    return this.raw.prepare(
      `SELECT * FROM github_links
       WHERE repository = ? AND pr_number IS NOT NULL
         AND pr_state NOT IN ('merged','closed')
       ORDER BY id ASC`
    ).all(repository) as GithubLink[];
  }

  listAllOpenAgentPrs(): GithubLink[] {
    return this.raw.prepare(
      `SELECT * FROM github_links
       WHERE pr_number IS NOT NULL
         AND pr_state NOT IN ('merged','closed')
       ORDER BY id ASC`
    ).all() as GithubLink[];
  }

  touchPrActivity(linkId: number, ts: string): void {
    this.raw.prepare(
      `UPDATE github_links SET last_activity_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(ts, linkId);
  }

  setProofCommentSha(linkId: number, sha: string): void {
    this.raw.prepare(
      `UPDATE github_links SET proof_comment_sha = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(sha, linkId);
  }

  countDailyAgentPrs(repository: string): number {
    const row = this.raw.prepare(
      `SELECT COUNT(*) AS n FROM github_links
       WHERE repository = ? AND pr_number IS NOT NULL
         AND DATE(created_at) = DATE('now')`
    ).get(repository) as { n: number };
    return row.n;
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

  cleanupOrphanedRuns(onOrphan: (run: { run_id: string; chat_id: string; bot: string }) => void | Promise<void>): void {
    const endedAt = new Date().toISOString();
    const orphans = this.raw
      .prepare(`SELECT run_id, chat_id, bot FROM bridge_runs WHERE status = 'running'`)
      .all() as Array<{ run_id: string; chat_id: string; bot: string }>;

    for (const run of orphans) {
      this.raw
        .prepare(
          `UPDATE bridge_runs
           SET status = 'failed', ended_at = ?, error = 'Process interrupted by bridge restart'
           WHERE run_id = ?`
        )
        .run(endedAt, run.run_id);
      
      try {
        onOrphan(run);
      } catch (err) {
        console.error(`Failed to handle orphaned run ${run.run_id}`, err);
      }
    }
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
