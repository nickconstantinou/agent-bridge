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
    command: string,
    cwd: string,
    model: string | null
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

  close(): void {
    this.raw.close();
  }
}
