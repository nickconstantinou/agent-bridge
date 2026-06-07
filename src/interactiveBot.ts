/**
 * PURPOSE: Interactive bot — single Telegram bot with switchable CLI routing.
 * Handles /switch and /cli commands; routes all other messages to the active CLI engine.
 * NEIGHBORS: src/index-interactive.ts, src/db.ts, src/engine.ts
 */

import type { BridgeDb } from "./db.js";

export type CliKind = "codex" | "claude" | "antigravity";

const VALID_CLI_KINDS: CliKind[] = ["codex", "claude", "antigravity"];
const DEFAULT_CLI: CliKind = "codex";

// ── DB helpers ────────────────────────────────────────────────────────────────

export function getUserCliPreference(db: BridgeDb, chatId: string): CliKind {
  try {
    db.raw
      .prepare(`ALTER TABLE bridge_state ADD COLUMN interactive_cli_preference TEXT`)
      .run();
  } catch { /* column already exists */ }

  const row = db.raw
    .prepare(`SELECT interactive_cli_preference AS pref FROM bridge_state WHERE chat_id = ?`)
    .get(chatId) as { pref: string | null } | undefined;

  const stored = row?.pref ?? null;
  return isValidCliKind(stored) ? stored : DEFAULT_CLI;
}

export function setUserCliPreference(db: BridgeDb, chatId: string, cli: CliKind): void {
  try {
    db.raw
      .prepare(`ALTER TABLE bridge_state ADD COLUMN interactive_cli_preference TEXT`)
      .run();
  } catch { /* column already exists */ }

  db.raw
    .prepare(
      `INSERT INTO bridge_state (chat_id, interactive_cli_preference) VALUES (?, ?)
       ON CONFLICT (chat_id) DO UPDATE SET interactive_cli_preference = excluded.interactive_cli_preference`
    )
    .run(chatId, cli);
}

// ── Command parsing ───────────────────────────────────────────────────────────

type SwitchOk = { ok: true; cli: CliKind };
type SwitchErr = { ok: false; error: string };
type SwitchResult = SwitchOk | SwitchErr;

/** Returns a SwitchResult for /switch commands, null for anything else. */
export function parseCliSwitchCommand(text: string): SwitchResult | null {
  const lower = text.trim().toLowerCase();
  if (!lower.startsWith("/switch")) return null;

  const parts = lower.split(/\s+/);
  if (parts[0] !== "/switch") return null;

  const arg = parts[1];
  if (!arg) {
    return { ok: false, error: `Specify a CLI: /switch ${VALID_CLI_KINDS.join(" | ")}` };
  }

  if (isValidCliKind(arg)) return { ok: true, cli: arg };
  return {
    ok: false,
    error: `Unknown CLI "${arg}". Available: ${VALID_CLI_KINDS.join(", ")}`,
  };
}

export function buildCliStatusText(activeCli: CliKind): string {
  const others = VALID_CLI_KINDS.filter((k) => k !== activeCli);
  return [
    `Active CLI: **${activeCli}**`,
    `Available: ${VALID_CLI_KINDS.join(", ")}`,
    `Switch with: /switch ${others[0]}`,
  ].join("\n");
}

// ── Internal ──────────────────────────────────────────────────────────────────

function isValidCliKind(value: unknown): value is CliKind {
  return VALID_CLI_KINDS.includes(value as CliKind);
}
