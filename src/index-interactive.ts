/**
 * PURPOSE: Entry point for the unified interactive bot.
 * One Telegram bot polls for messages; each message is routed to the user's
 * preferred CLI engine (codex | claude | antigravity). /cli shows the active
 * CLI and an inline keyboard for one-tap switching.
 * NEIGHBORS: src/interactiveBot.ts, src/engine.ts, src/bridge.ts, src/db.ts
 */

import dotenv from "dotenv";
import {
  validateBridgeConfig,
  getBridgeProjectDir,
  openDb,
  shutdownCliProcesses,
} from "./bridge.js";
import { TelegramClient } from "./telegram.js";
import { BridgeEngine } from "./engine.js";
import { defaultSoulPath, loadSoulContext, normalizeSoulMode } from "./soul.js";
import { resolveTimeoutsForKind } from "./timeouts.js";
import { sendTelegramMessage } from "./messageDelivery.js";
import { isAuthorizedMessage, extractPromptText, parseModelPreference } from "./bridge.js";
import { WorkerFallbackChain } from "./workerFallback.js";
import {
  getUserCliPreference,
  setUserCliPreference,
  buildCliStatusText,
  buildCliKeyboard,
  handleCliSwitchCallback,
  buildInteractiveCommands,
  resolveUpdateChatKey,
  resolveMessageThreadId,
  isAuthorizedInteractiveUpdate,
  isCliCommandText,
  describeInteractiveUpdateForLog,
  isGroupInteractiveUpdate,
  dispatchInteractiveWithFallback,
  type CliKind,
} from "./interactiveBot.js";
import type { BridgeConfig, BotKind, TelegramUpdate } from "./types.js";

dotenv.config({
  path: process.env.BRIDGE_ENV_FILE || ".env.interactive",
  override: false,
});

const token = process.env.TELEGRAM_BOT_TOKEN_INTERACTIVE;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN_INTERACTIVE is required");

const allowedUserIds = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS || process.env.TELEGRAM_ALLOWED_USER_ID || "")
    .split(",").map(s => s.trim()).filter(Boolean)
);

const dbPath = process.env.DB_PATH || `${getBridgeProjectDir()}/.data/bridge.sqlite`;
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || 1000);
const executionMode = (process.env.BRIDGE_EXECUTION_MODE as "safe" | "trusted") || "safe";
const asyncEnabled = process.env.BRIDGE_ASYNC_ENABLED !== "false";

const config: BridgeConfig = {
  allowedUserIds,
  serviceEnvFile: process.env.BRIDGE_ENV_FILE || null,
  serviceKind: null,
  pollIntervalMs,
  executionMode,
  asyncEnabled,
  dbPath,
  bots: {
    codex: {
      token: undefined,
      command: process.env.CODEX_COMMAND || "codex",
      modelPreference: parseModelPreference(process.env.CODEX_MODEL_PREFERENCE),
    },
    antigravity: {
      token: undefined,
      command: process.env.ANTIGRAVITY_COMMAND || "agy",
      modelPreference: parseModelPreference(process.env.ANTIGRAVITY_MODEL_PREFERENCE),
    },
    claude: {
      token: undefined,
      command: process.env.CLAUDE_COMMAND || "claude",
      modelPreference: parseModelPreference(process.env.CLAUDE_MODEL_PREFERENCE),
    },
  },
};

const soulContext = loadSoulContext({
  mode: normalizeSoulMode(process.env.AGENT_BRIDGE_SOUL_MODE),
  path: process.env.AGENT_BRIDGE_SOUL_PATH || defaultSoulPath(getBridgeProjectDir()),
});
if (soulContext) console.log(`[interactive] loaded SOUL.md context (${soulContext.length} chars)`);

const db = openDb(dbPath);
const client = new TelegramClient(token, fetch, 45_000);
let botUsername = process.env.TELEGRAM_BOT_USERNAME || null;
if (!botUsername) {
  try {
    const me = await client.call<{ username?: string }>("getMe");
    botUsername = me.result.username ?? null;
  } catch (err) {
    console.warn("[interactive] getMe failed; group-suffixed /cli commands disabled", err);
  }
}

// Fallback chain state
const cliChain = (process.env.INTERACTIVE_CLI_CHAIN || process.env.WORKER_CLI_CHAIN || "codex,claude,antigravity")
  .split(",").map(s => s.trim()).filter(Boolean);
const fallbackChain = new WorkerFallbackChain(cliChain);
const exhaustedChats = new Set<string>();
const contextPreambles = new Map<string, string>();

// Build one engine per CLI kind — none polls; we dispatch handleUpdate manually.
const CLI_KINDS: CliKind[] = ["codex", "claude", "antigravity"];
const engines = Object.fromEntries(
  CLI_KINDS.map((kind) => {
    const botConfig = config.bots[kind as BotKind];
    return [
      kind,
      new BridgeEngine(
        {
          kind,
          botConfig: { ...botConfig, token },
          allowedUserIds,
          executionMode,
          asyncEnabled,
          pollIntervalMs,
          soulContext,
          fullConfig: config,
          hooks: {
            onCapacityExhausted: async (chatKey: string) => {
              exhaustedChats.add(chatKey);
            },
            onBeforeExecute: async (prompt: string, ctx: { chatKey: string }) => {
              const preamble = contextPreambles.get(ctx.chatKey);
              if (preamble) {
                contextPreambles.delete(ctx.chatKey);
                return preamble + prompt;
              }
              return prompt;
            },
            onAfterExecute: async (prompt: string, resultText: string, ctx: { chatKey: string }) => {
              fallbackChain.addTurn(ctx.chatKey, "assistant", resultText);
            },
          },
        },
        db,
        client,
      ),
    ];
  }),
) as Record<CliKind, BridgeEngine>;

const defaultPref = getUserCliPreference(db, "default");
await client.setMyCommands({ commands: buildInteractiveCommands(defaultPref) })
  .catch((err: unknown) => console.warn("[interactive] setMyCommands failed", err));
await client.setMyCommands({ commands: buildInteractiveCommands(defaultPref), scope: { type: "all_group_chats" } })
  .catch((err: unknown) => console.warn("[interactive] setMyCommands (groups) failed", err));

console.log("[interactive] starting polling...");

let offset = db.getLastUpdateId("codex"); // reuse existing offset tracking
const POLL_KIND = "codex" as const;

for (;;) {
  try {
    const updates = await client.getUpdates({ offset: offset + 1, timeout: 30, allowed_updates: ["message", "callback_query"] });

    for (const update of (updates.result as any) ?? []) {
      const updateId: number = update.update_id;
      offset = updateId;
      db.setLastUpdateId(POLL_KIND, updateId);

      try {
        const typedUpdate = update as TelegramUpdate;
        const isGroupUpdate = isGroupInteractiveUpdate(typedUpdate);
        if (isGroupUpdate) {
          console.log("[interactive] update.received", JSON.stringify(describeInteractiveUpdateForLog(typedUpdate)));
        }

        if (!isAuthorizedInteractiveUpdate(typedUpdate, allowedUserIds)) {
          if (isGroupUpdate) {
            console.warn("[interactive] update.ignored", JSON.stringify({
              ...describeInteractiveUpdateForLog(typedUpdate),
              reason: typedUpdate.message?.sender_chat && !typedUpdate.message?.from ? "anonymous_sender_chat" : "unauthorized_user",
            }));
          }
          continue;
        }

        // Handle /cli before engine dispatch
        const message = typedUpdate.message;
        if (message) {
          const rawText = (message.text || "").trim();
          const chatId = message.chat.id;
          const chatKey = resolveUpdateChatKey(typedUpdate) ?? String(chatId);

          if (isCliCommandText(rawText, botUsername)) {
            const pref = getUserCliPreference(db, chatKey);
            await sendTelegramMessage({ client, kind: "interactive", chatId, body: {
              text: buildCliStatusText(pref),
              reply_markup: buildCliKeyboard(pref),
              message_thread_id: message.message_thread_id,
            } });
            continue;
          }
        }

        // Handle cli:* callback taps (CLI switch from inline keyboard)
        const cbq = typedUpdate.callback_query;
        if (cbq?.data) {
          const newCli = handleCliSwitchCallback(cbq.data);
          if (newCli !== null) {
            const chatId = cbq.message?.chat?.id;
            const messageId = cbq.message?.message_id;
            const chatKey = resolveUpdateChatKey(typedUpdate);
            if (chatKey) {
              setUserCliPreference(db, chatKey, newCli);
              fallbackChain.setActiveCli(chatKey, newCli);
              const preamble = fallbackChain.buildContextPreamble(chatKey);
              if (preamble) contextPreambles.set(chatKey, preamble);
            }
            await client.answerCallbackQuery({ callback_query_id: cbq.id, text: `Switched to ${newCli}` });
            if (chatId && messageId) {
              await client.editMessageText({
                chat_id: chatId,
                message_id: messageId,
                text: buildCliStatusText(newCli),
                reply_markup: buildCliKeyboard(newCli),
              });
            }
            if (chatKey) {
              await client.setMyCommands({ commands: buildInteractiveCommands(newCli) })
                .catch((err: unknown) => console.warn("[interactive] setMyCommands failed after cli callback", err));
              await client.setMyCommands({ commands: buildInteractiveCommands(newCli), scope: { type: "all_group_chats" } })
                .catch((err: unknown) => console.warn("[interactive] setMyCommands (groups) failed after cli callback", err));
            }
            continue;
          }
        }

        // Route to the user's preferred engine with fallback support
        const chatKey = resolveUpdateChatKey(typedUpdate);
        if (chatKey) {
          const messageText = typedUpdate.message?.text?.trim() || "";
          if (messageText) {
            fallbackChain.addTurn(chatKey, "user", messageText);
          }
          const chatId = typedUpdate.message?.chat?.id ?? typedUpdate.callback_query?.message?.chat?.id;
          const threadId = resolveMessageThreadId(typedUpdate);
          if (chatId != null) {
            dispatchInteractiveWithFallback(typedUpdate, chatKey, {
              engines,
              fallbackChain,
              exhaustedChats,
              contextPreambles,
              db,
              notify: async (msg) => {
                await sendTelegramMessage({ client, kind: "interactive", chatId, body: { text: msg, message_thread_id: threadId } });
              },
              onCliSwitched: async (newCli) => {
                await client.setMyCommands({ commands: buildInteractiveCommands(newCli) })
                  .catch((err: unknown) => console.warn("[interactive] setMyCommands failed during fallback", err));
                await client.setMyCommands({ commands: buildInteractiveCommands(newCli), scope: { type: "all_group_chats" } })
                  .catch((err: unknown) => console.warn("[interactive] setMyCommands (groups) failed during fallback", err));
              },
            }).catch((err: unknown) => console.error("[interactive] dispatch error", err));
          } else {
            const pref = getUserCliPreference(db, chatKey);
            engines[pref].handleUpdate(typedUpdate)
              .catch((err: unknown) => console.error("[interactive] handleUpdate error", err));
          }
        } else {
          const pref = "codex";
          await engines[pref].handleUpdate(typedUpdate);
        }
      } catch (err) {
        console.error("[interactive] update handling failed", err);
      }
    }
  } catch (err) {
    console.error("[interactive] poll error", err);
    await new Promise(r => setTimeout(r, 5000));
  }
}
