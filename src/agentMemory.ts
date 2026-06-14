import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

export type MemoryScope = "project" | "personal" | "team";
export type MemoryType = "decision" | "bug" | "convention" | "todo" | "note";

export interface MemoryRecord {
  id: string;
  type: MemoryType;
  scope: MemoryScope;
  text: string;
  created_at: string;
  score?: number;
  source: string;
}

const DEFAULT_DB_PATH = `${process.env.HOME || ""}/.agent-bridge/shared-memory/agent-memory.sqlite`;

export function getAgentMemoryDbPath(): string {
  return process.env.AGENT_MEMORY_DB_PATH || DEFAULT_DB_PATH;
}

export function ensureMemoryDbPath(path = getAgentMemoryDbPath()): void {
  if (!isAbsolute(path)) throw new Error("Agent memory database path must be absolute.");
  mkdirSync(dirname(path), { recursive: true });
}

function openDb(path = getAgentMemoryDbPath()) {
  ensureMemoryDbPath(path);
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      scope TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, text, content='memories', content_rowid='rowid');
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, id, text) VALUES (new.rowid, new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, id, text) VALUES('delete', old.rowid, old.id, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, id, text) VALUES('delete', old.rowid, old.id, old.text);
      INSERT INTO memories_fts(rowid, id, text) VALUES (new.rowid, new.id, new.text);
    END;
  `);
  return db;
}

function makeId(): string {
  return `mem_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function addMemory(input: { type: MemoryType; scope: MemoryScope; text: string; source?: string }): MemoryRecord {
  const db = openDb();
  const record: MemoryRecord = {
    id: makeId(),
    type: input.type,
    scope: input.scope,
    text: input.text.trim(),
    created_at: new Date().toISOString(),
    source: input.source || "manual",
  };
  db.prepare(
    "INSERT INTO memories (id, type, scope, text, created_at, source) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(record.id, record.type, record.scope, record.text, record.created_at, record.source);
  return record;
}

export function recallMemories(input: { query: string; scope?: MemoryScope; limit?: number }): MemoryRecord[] {
  const db = openDb();
  const limit = Math.max(1, Math.min(input.limit ?? 10, 100));
  const query = input.query.trim();
  try {
    const rows = db.prepare(`
      SELECT m.id, m.type, m.scope, m.text, m.created_at, m.source,
             -bm25(memories_fts) AS score
      FROM memories_fts
      JOIN memories m ON m.rowid = memories_fts.rowid
      WHERE memories_fts MATCH ?
        ${input.scope ? "AND m.scope = ?" : ""}
      ORDER BY score DESC
      LIMIT ?
    `).all(input.scope ? [query, input.scope, limit] : [query, limit]);
    return rows as MemoryRecord[];
  } catch {
    const rows = db.prepare(`
      SELECT id, type, scope, text, created_at, source
      FROM memories
      WHERE text LIKE ? ${input.scope ? "AND scope = ?" : ""}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(input.scope ? [`%${query}%`, input.scope, limit] : [`%${query}%`, limit]);
    return rows as MemoryRecord[];
  }
}

export const searchMemories = recallMemories;

export function listMemories(input: { scope?: MemoryScope; limit?: number } = {}): MemoryRecord[] {
  const db = openDb();
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const rows = db.prepare(`
    SELECT id, type, scope, text, created_at, source
    FROM memories
    ${input.scope ? "WHERE scope = ?" : ""}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(input.scope ? [input.scope, limit] : [limit]);
  return rows as MemoryRecord[];
}

export function updateMemory(input: { id: string; type?: MemoryType; scope?: MemoryScope; text?: string }): MemoryRecord {
  const db = openDb();
  const existing = db.prepare("SELECT * FROM memories WHERE id = ?").get(input.id) as MemoryRecord | undefined;
  if (!existing) throw new Error(`Memory not found: ${input.id}`);
  const next = {
    ...existing,
    type: input.type || existing.type,
    scope: input.scope || existing.scope,
    text: input.text?.trim() || existing.text,
  };
  db.prepare("UPDATE memories SET type = ?, scope = ?, text = ? WHERE id = ?").run(next.type, next.scope, next.text, input.id);
  return next;
}

export function deleteMemory(id: string): boolean {
  const db = openDb();
  const result = db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  return result.changes > 0;
}

export function exportMemoryJson(records: MemoryRecord[]): string {
  return `${JSON.stringify(records, null, 2)}\n`;
}

export function hasMemoryText(text: string): boolean {
  const db = openDb();
  const found = db.prepare("SELECT id FROM memories WHERE text = ? LIMIT 1").get(text.trim());
  return Boolean(found);
}

export function importMemoryText(input: { type: MemoryType; scope: MemoryScope; text: string; source?: string }): MemoryRecord | null {
  const text = input.text.trim();
  if (!text || hasMemoryText(text)) return null;
  return addMemory({ ...input, text });
}
