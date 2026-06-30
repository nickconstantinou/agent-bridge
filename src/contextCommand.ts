/**
 * PURPOSE: Read-only helper for agents to inspect Agent Bridge conversation context.
 * INPUTS: AGENT_BRIDGE_CONTEXT_DB, AGENT_BRIDGE_CHAT_KEY, and CLI args.
 * OUTPUTS: Compact Markdown for latest summary or recent turns.
 * NEIGHBORS: src/engine.ts, bin/agent-bridge-context
 */

import Database from "better-sqlite3";
import { BridgeDb, buildMemoryFtsQuery } from "./db.js";
import { formatProjectMemoryStoreResult, storeProjectMemoryCandidateJson } from "./projectMemory.js";

type EnvLike = Record<string, string | undefined>;

function requireEnv(env: EnvLike, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function parseLimit(args: string[], flag: string, fallback: number): number {
  const idx = args.indexOf(flag);
  if (idx === -1) return fallback;
  const raw = Number(args[idx + 1]);
  if (!Number.isInteger(raw) || raw < 1) return fallback;
  return Math.min(raw, 100);
}

function openReadonly(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function openReadWrite(dbPath: string): Database.Database {
  return new Database(dbPath, { fileMustExist: true });
}

function buildQueryFromContext(db: Database.Database, chatKey: string): string {
  const turns = db.prepare(
    `SELECT text FROM conversation_turns WHERE chat_key = ? ORDER BY id DESC LIMIT 5`
  ).all(chatKey) as Array<{ text: string }>;
  const summary = db.prepare(
    `SELECT summary_md FROM conversation_summaries WHERE chat_key = ? ORDER BY id DESC LIMIT 1`
  ).get(chatKey) as { summary_md: string } | undefined;

  const raw = [summary?.summary_md ?? "", ...turns.map(t => t.text)].join(" ");
  const words = [...new Set(
    raw.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 3)
  )].slice(0, 12);
  return words.join(" ");
}

function searchMemories(db: Database.Database, query: string, chatKey: string): string {
  if (!query.trim()) return "No project memories found.";
  const ftsQuery = buildMemoryFtsQuery(query);
  if (!ftsQuery) return "No project memories found.";
  try {
    const rows = db.prepare(`
      SELECT
        pm.id,
        pm.type,
        pm.text,
        rank AS score,
        snippet(project_memories_fts, 1, '', '', '...', 12) AS snippet
      FROM project_memories_fts fts
      JOIN project_memories pm ON pm.rowid = fts.rowid
      WHERE project_memories_fts MATCH ?
        AND (pm.scope IN ('project', 'global') OR (pm.scope = 'chat' AND pm.source_chat_key = ?))
      ORDER BY rank
      LIMIT 5
    `).all(ftsQuery, chatKey) as Array<{ id: string; type: string; text: string; score: number; snippet: string }>;

    if (!rows.length) return "No project memories found matching that query.";
    const items = rows.map((r, i) => {
      const score = Number.isFinite(r.score) ? ` score=${r.score.toFixed(3)}` : "";
      const snippet = r.snippet && r.snippet !== r.text ? `\n   ${r.snippet}` : "";
      return `${i + 1}. [${r.type}] ${r.id}${score}\n   ${r.text}${snippet}`;
    }).join("\n");
    return `Project memories (${rows.length}):\n${items}`;
  } catch {
    return "No project memories found.";
  }
}

function addMemoryJson(db: Database.Database, rawJson: string, env: EnvLike): string {
  const chatKey = requireEnv(env, "AGENT_BRIDGE_CHAT_KEY");
  const result = storeProjectMemoryCandidateJson(new BridgeDb(db), rawJson, {
    chatKey,
    cliKind: env.AGENT_BRIDGE_CLI_KIND,
    repoPath: env.AGENT_BRIDGE_REPO_PATH,
  });
  return formatProjectMemoryStoreResult(result);
}

function latestSummary(db: Database.Database, chatKey: string): string {
  const row = db.prepare(
    `SELECT summary_md, created_at
     FROM conversation_summaries
     WHERE chat_key = ?
     ORDER BY id DESC
     LIMIT 1`,
  ).get(chatKey) as { summary_md: string; created_at: string } | undefined;

  if (!row) return "No compact summary found.";
  return [`Latest compact summary (${row.created_at}):`, "", row.summary_md].join("\n");
}

function recentTurns(db: Database.Database, chatKey: string, limit: number): string {
  const rows = db.prepare(
    `SELECT role, text, cli, created_at
     FROM (
       SELECT id, role, text, cli, created_at
       FROM conversation_turns
       WHERE chat_key = ?
       ORDER BY id DESC
       LIMIT ?
     )
     ORDER BY id ASC`,
  ).all(chatKey, limit) as Array<{ role: string; text: string; cli: string | null; created_at: string }>;

  if (!rows.length) return "No recent conversation turns found.";
  return rows.map((row) => {
    const label = row.role === "user" ? "User" : "Assistant";
    const cli = row.cli ? ` via ${row.cli}` : "";
    return `${label}: ${row.text} (${row.created_at}${cli})`;
  }).join("\n");
}

export function renderAgentBridgeContext(args: string[], env: EnvLike = process.env): string {
  const dbPath = requireEnv(env, "AGENT_BRIDGE_CONTEXT_DB");
  const chatKey = requireEnv(env, "AGENT_BRIDGE_CHAT_KEY");
  if (args.includes("--memory-add-json")) {
    const idx = args.indexOf("--memory-add-json");
    const db = openReadWrite(dbPath);
    try {
      return addMemoryJson(db, args[idx + 1] ?? "", env);
    } finally {
      db.close();
    }
  }

  const db = openReadonly(dbPath);
  try {
    if (args.includes("--recent")) {
      return recentTurns(db, chatKey, parseLimit(args, "--recent", 20));
    }
    if (args.includes("--memory-query")) {
      const idx = args.indexOf("--memory-query");
      const query = args[idx + 1] ?? "";
      return searchMemories(db, query, chatKey);
    }
    if (args.includes("--memory")) {
      const query = buildQueryFromContext(db, chatKey);
      return searchMemories(db, query, chatKey);
    }
    return latestSummary(db, chatKey);
  } finally {
    db.close();
  }
}
