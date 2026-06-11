/**
 * PURPOSE: Interactive bot — single Telegram bot with switchable CLI routing.
 * Handles /switch and /cli commands; routes all other messages to the active CLI engine.
 * NEIGHBORS: src/index-interactive.ts, src/db.ts, src/engine.ts
 */

import type { BridgeDb } from "./db.js";
import type { TelegramUpdate } from "./types.js";
import { buildTelegramCommands } from "./commands.js";
import { WorkerFallbackChain } from "./workerFallback.js";

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

/** Parses a cli:* callback_data string into a CliKind, or returns null. */
export function handleCliSwitchCallback(data: string): CliKind | null {
  if (!data.startsWith("cli:")) return null;
  const kind = data.slice(4);
  return isValidCliKind(kind) ? kind : null;
}

export function buildCliStatusText(activeCli: CliKind): string {
  const others = VALID_CLI_KINDS.filter((k) => k !== activeCli);
  return [
    `Active CLI: **${activeCli}**`,
    `Available: ${VALID_CLI_KINDS.join(", ")}`,
    `Switch with: /switch ${others[0]}`,
  ].join("\n");
}

export function buildCliKeyboard(activeCli: CliKind): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return {
    inline_keyboard: VALID_CLI_KINDS.map((cli) => [{
      text: cli === activeCli ? `✓ ${cli}` : cli,
      callback_data: `cli:${cli}`,
    }]),
  };
}

// ── Telegram command registration ─────────────────────────────────────────────

/** Returns the merged command list for setMyCommands: interactive commands + active CLI commands. */
export function buildInteractiveCommands(pref: CliKind): Array<{ command: string; description: string }> {
  const interactiveOnly = [
    { command: "cli", description: "Show active CLI and switch with one tap" },
  ];
  const cliKind = pref === "antigravity" ? "antigravity" : pref === "claude" ? "claude" : "codex";
  const cliCmds = buildTelegramCommands(cliKind);
  const seen = new Set(interactiveOnly.map(c => c.command));
  const merged = [...interactiveOnly];
  for (const cmd of cliCmds) {
    if (!seen.has(cmd.command)) {
      seen.add(cmd.command);
      merged.push(cmd);
    }
  }
  return merged;
}

// ── Update routing helpers ────────────────────────────────────────────────────

/** Returns the chat key (string chat_id) from a message or callback_query update, or null. */
export function resolveUpdateChatKey(update: TelegramUpdate): string | null {
  const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
  return chatId != null ? String(chatId) : null;
}

/** Returns true if the update's sender (message.from or callback_query.from) is in the allowed set. */
export function isAuthorizedInteractiveUpdate(
  update: TelegramUpdate,
  allowedUserIds: ReadonlySet<string>,
): boolean {
  const userId = update.message?.from?.id ?? update.callback_query?.from?.id;
  if (userId == null) return false;
  return allowedUserIds.has(String(userId));
}

// ── Internal ──────────────────────────────────────────────────────────────────

function isValidCliKind(value: unknown): value is CliKind {
  return VALID_CLI_KINDS.includes(value as CliKind);
}

// ── Interactive Dispatch with Fallback ────────────────────────────────────────

export interface InteractiveDispatchEngine {
  handleUpdate(update: TelegramUpdate): Promise<void>;
}

export interface InteractiveDispatchDeps {
  engines: Record<string, InteractiveDispatchEngine>;
  fallbackChain: WorkerFallbackChain;
  exhaustedChats: Set<string>;
  contextPreambles: Map<string, string>;
  db: BridgeDb;
  notify: (msg: string) => Promise<void> | void;
  onCliSwitched?: (newCli: CliKind) => Promise<void> | void;
}

export async function dispatchInteractiveWithFallback(
  update: TelegramUpdate,
  chatKey: string,
  deps: InteractiveDispatchDeps,
): Promise<void> {
  const { engines, fallbackChain, exhaustedChats, contextPreambles, db, notify, onCliSwitched } = deps;

  exhaustedChats.delete(chatKey);

  const pref = getUserCliPreference(db, chatKey);
  fallbackChain.setActiveCli(chatKey, pref);

  const activeCli = fallbackChain.getActiveCli(chatKey) as CliKind;
  await engines[activeCli].handleUpdate(update);

  if (exhaustedChats.has(chatKey)) {
    exhaustedChats.delete(chatKey);
    const next = fallbackChain.advance(chatKey) as CliKind | null;
    if (next) {
      contextPreambles.set(chatKey, fallbackChain.buildContextPreamble(chatKey));
      setUserCliPreference(db, chatKey, next);

      await notify(`Switching to ${next} (${activeCli} at capacity)`);
      if (onCliSwitched) {
        await onCliSwitched(next);
      }

      await dispatchInteractiveWithFallback(update, chatKey, deps);
    } else {
      await notify("All CLIs are currently unavailable. Please try again later.");
    }
  }
}
