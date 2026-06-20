/**
 * PURPOSE: Read-only helper for agents to inspect Agent Bridge conversation context.
 * INPUTS: AGENT_BRIDGE_CONTEXT_DB, AGENT_BRIDGE_CHAT_KEY, and CLI args.
 * OUTPUTS: Compact Markdown for latest summary or recent turns.
 * NEIGHBORS: src/engine.ts, bin/agent-bridge-context
 */

import Database from "better-sqlite3";

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
  const db = openReadonly(dbPath);
  try {
    if (args.includes("--recent")) {
      return recentTurns(db, chatKey, parseLimit(args, "--recent", 20));
    }
    return latestSummary(db, chatKey);
  } finally {
    db.close();
  }
}
