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
  raw.exec(`
    CREATE TABLE IF NOT EXISTS bridge_state (
      chat_id               TEXT    PRIMARY KEY,
      codex_session_id      TEXT,
      gemini_session_id     TEXT,
      claude_session_id     TEXT,
      antigravity_session_id TEXT,
      active_execution_lock INTEGER NOT NULL DEFAULT 0,
      last_update_id        INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
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
  return new BridgeDb(raw);
}

export class BridgeDb {
  private readonly raw: Database.Database;

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
    this.raw
      .prepare(
        `INSERT INTO bridge_state (chat_id, ${col}) VALUES (?, ?)
         ON CONFLICT (chat_id) DO UPDATE SET ${col} = excluded.${col}`
      )
      .run(chatId, sessionId);
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

  setSetting(key: string, value: string | null): void {
    this.raw
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }

  close(): void {
    this.raw.close();
  }
}
