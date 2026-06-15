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
export type InteractiveCommandRegistration = {
  commands: Array<{ command: string; description: string }>;
  scope?: { type: "all_group_chats" | "all_chat_administrators" } | { type: "chat" | "chat_administrators"; chat_id: number };
};

const VALID_CLI_KINDS: CliKind[] = ["codex", "claude", "antigravity"];
const DEFAULT_CLI: CliKind = "codex";

export interface InteractiveUpdateLogSummary {
  updateId: number;
  kind: "message" | "callback_query" | "other";
  chatId: number | null;
  chatType: string | null;
  threadId: number | null;
  fromId: number | null;
  senderChatId: number | null;
  content: "text" | "caption" | "non_text" | null;
  contentDetail: string | null;
}

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

export function isCliCommandText(rawText: string, botUsername?: string | null): boolean {
  const command = rawText.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (command === "/cli") return true;
  if (!botUsername || !command?.startsWith("/cli@")) return false;
  return command.slice("/cli@".length) === botUsername.toLowerCase();
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

export function buildGlobalInteractiveCommandRegistrations(pref: CliKind): InteractiveCommandRegistration[] {
  const commands = buildInteractiveCommands(pref);
  return [
    { commands },
    { commands, scope: { type: "all_group_chats" } },
    { commands, scope: { type: "all_chat_administrators" } },
  ];
}

export function buildChatInteractiveCommandRegistrations(pref: CliKind, chatId: number): InteractiveCommandRegistration[] {
  const commands = buildInteractiveCommands(pref);
  return [
    { commands, scope: { type: "chat", chat_id: chatId } },
    { commands, scope: { type: "chat_administrators", chat_id: chatId } },
  ];
}

// ── Update routing helpers ────────────────────────────────────────────────────

/** Returns the chat key from an update. For group/supergroup messages with a thread, returns "chatId:threadId". */
export function resolveUpdateChatKey(update: TelegramUpdate): string | null {
  const msg = update.message;
  const cbqMsg = update.callback_query?.message;
  const chatId = msg?.chat?.id ?? cbqMsg?.chat?.id;
  if (chatId == null) return null;
  const source = msg ?? cbqMsg;
  const isGroup = source?.chat?.type === "group" || source?.chat?.type === "supergroup";
  const threadId = source?.message_thread_id;
  if (isGroup && threadId != null) return `${chatId}:${threadId}`;
  return String(chatId);
}

/** Returns the message_thread_id from a message or callback_query update, or undefined. */
export function resolveMessageThreadId(update: TelegramUpdate): number | undefined {
  return update.message?.message_thread_id ?? update.callback_query?.message?.message_thread_id;
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

export function describeInteractiveUpdateForLog(update: TelegramUpdate): InteractiveUpdateLogSummary {
  const message = update.message ?? update.callback_query?.message;
  const sender = update.message?.from ?? update.callback_query?.from;
  const contentDetail = describeMessageContentDetail(update.message);
  return {
    updateId: update.update_id,
    kind: update.message ? "message" : update.callback_query ? "callback_query" : "other",
    chatId: message?.chat?.id ?? null,
    chatType: message?.chat?.type ?? null,
    threadId: message?.message_thread_id ?? null,
    fromId: sender?.id ?? null,
    senderChatId: update.message?.sender_chat?.id ?? null,
    content: update.message?.text ? "text" : update.message?.caption ? "caption" : update.message ? "non_text" : null,
    contentDetail,
  };
}

export function isGroupInteractiveUpdate(update: TelegramUpdate): boolean {
  const chatType = update.message?.chat?.type ?? update.callback_query?.message?.chat?.type;
  return chatType === "group" || chatType === "supergroup";
}

// ── Internal ──────────────────────────────────────────────────────────────────

function isValidCliKind(value: unknown): value is CliKind {
  return VALID_CLI_KINDS.includes(value as CliKind);
}

function describeMessageContentDetail(message: TelegramUpdate["message"]): string | null {
  if (!message) return null;
  if (message.text) return "text";
  if (message.caption) return "caption";

  const subtypeKeys = [
    "photo",
    "document",
    "sticker",
    "animation",
    "video",
    "voice",
    "audio",
    "video_note",
    "contact",
    "location",
    "venue",
    "poll",
    "dice",
    "new_chat_members",
    "left_chat_member",
    "pinned_message",
    "forum_topic_created",
    "forum_topic_closed",
    "forum_topic_reopened",
    "general_forum_topic_hidden",
    "general_forum_topic_unhidden",
    "migrate_to_chat_id",
    "migrate_from_chat_id",
    "successful_payment",
  ];

  const record = message as unknown as Record<string, unknown>;
  return subtypeKeys.find((key) => record[key] != null) ?? "unknown_non_text";
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
  tried = new Set<string>(),
): Promise<void> {
  const { engines, fallbackChain, exhaustedChats, contextPreambles, db, notify, onCliSwitched } = deps;

  exhaustedChats.delete(chatKey);

  if (tried.size === 0) {
    const pref = getUserCliPreference(db, chatKey);
    fallbackChain.setActiveCli(chatKey, pref);
  }

  const activeCli = fallbackChain.getActiveCli(chatKey) as CliKind;
  tried.add(activeCli);
  await engines[activeCli].handleUpdate(update);

  if (exhaustedChats.has(chatKey)) {
    exhaustedChats.delete(chatKey);
    let next: CliKind | null = null;
    const chain = fallbackChain.getChain();
    for (const cli of chain) {
      if (!tried.has(cli)) {
        next = cli as CliKind;
        break;
      }
    }
    if (next) {
      fallbackChain.setActiveCli(chatKey, next);
      contextPreambles.set(chatKey, fallbackChain.buildContextPreamble(chatKey));
      // Do NOT write setUserCliPreference here — auto-fallback is temporary and must
      // not overwrite the user's explicit preference. Each new message resets to the
      // stored preference, allowing the 1st choice to be retried on recovery.

      await notify(`Switching to ${next} (${activeCli} at capacity)`);
      if (onCliSwitched) {
        await onCliSwitched(next);
      }

      await dispatchInteractiveWithFallback(update, chatKey, deps, tried);
    } else {
      await notify("All CLIs are currently unavailable. Please try again later.");
    }
  }
}
