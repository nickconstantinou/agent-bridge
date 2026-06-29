import Database from "better-sqlite3";
import { buildMemoryFtsQuery } from "../db.js";

export class MemoryRepository {
  constructor(private readonly db: Database.Database) {}

  addMemory(mem: {
    id: string;
    type: string;
    scope?: string;
    text: string;
    source_chat_key?: string;
    source_cli?: string;
    source_turn_id?: number;
    source_repo_path?: string;
    confidence?: number;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO project_memories (id, type, scope, text, source_chat_key, source_cli, source_turn_id, source_repo_path, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      mem.id,
      mem.type,
      mem.scope ?? "project",
      mem.text,
      mem.source_chat_key ?? null,
      mem.source_cli ?? null,
      mem.source_turn_id ?? null,
      mem.source_repo_path ?? null,
      mem.confidence ?? 1.0,
    );
  }

  searchMemories(query: string, limit = 5): Array<{ id: string; type: string; text: string; score: number; snippet: string }> {
    if (!query.trim()) return [];
    const ftsQuery = buildMemoryFtsQuery(query);
    if (!ftsQuery) return [];
    try {
      return this.db.prepare(`
        SELECT
          pm.id,
          pm.type,
          pm.text,
          rank AS score,
          snippet(project_memories_fts, 1, '', '', '...', 12) AS snippet
        FROM project_memories_fts fts
        JOIN project_memories pm ON pm.rowid = fts.rowid
        WHERE project_memories_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit) as Array<{ id: string; type: string; text: string; score: number; snippet: string }>;
    } catch {
      return [];
    }
  }

  getMemoryCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM project_memories").get() as { n: number }).n;
  }

  findMemoryByText(text: string): { id: string } | null {
    return (this.db.prepare(
      `SELECT id FROM project_memories WHERE lower(text) = lower(?) LIMIT 1`,
    ).get(text) as { id: string } | undefined) ?? null;
  }

  getLatestConvTurnId(chatKey: string): number | null {
    const row = this.db.prepare(
      `SELECT id FROM conversation_turns WHERE chat_key = ? ORDER BY id DESC LIMIT 1`,
    ).get(chatKey) as { id: number } | undefined;
    return row?.id ?? null;
  }
}
