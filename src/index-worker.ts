/**
 * PURPOSE: Entry point for the autonomous worker bot.
 * Handles /jobs, /issues, /review, /models commands. Routes plain messages
 * to the active CLI engine via a fallback chain (codex → claude → antigravity).
 * When a CLI is at capacity, the chain advances and retries with the next CLI,
 * injecting the last 3 turns as context.
 * NEIGHBORS: src/workerBot.ts, src/engine.ts, src/workerFallback.ts, src/workerDispatch.ts
 */

import dotenv from "dotenv";
import {
  getBridgeProjectDir,
  openDb,
  isAuthorizedMessage,
  shutdownCliProcesses,
} from "./bridge.js";
import { TelegramClient } from "./telegram.js";
import { BridgeEngine } from "./engine.js";
import { sendTelegramMessage } from "./messageDelivery.js";
import { handleWorkerCommand, isWorkerCommand, buildWorkerCommands } from "./workerBot.js";
import { WorkerFallbackChain } from "./workerFallback.js";
import { dispatchWithFallback } from "./workerDispatch.js";
import type { BridgeConfig, BotKind, TelegramUpdate } from "./types.js";

dotenv.config({
  path: process.env.BRIDGE_ENV_FILE || ".env.worker",
  override: false,
});

const token = process.env.TELEGRAM_BOT_TOKEN_WORKER;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN_WORKER is required");

const allowedUserIds = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS || process.env.TELEGRAM_ALLOWED_USER_ID || "")
    .split(",").map(s => s.trim()).filter(Boolean)
);

const workerEnabled = process.env.WORKER_ENABLED === "true";
const cliChain = (process.env.WORKER_CLI_CHAIN || "codex,claude,antigravity")
  .split(",").map(s => s.trim()).filter(Boolean);
const dbPath = process.env.DB_PATH || `${getBridgeProjectDir()}/.data/bridge.sqlite`;
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || 1000);
const executionMode = (process.env.BRIDGE_EXECUTION_MODE as "safe" | "trusted") || "safe";
const asyncEnabled = process.env.BRIDGE_ASYNC_ENABLED !== "false";

function parseModelPreference(raw: string | undefined): string[] {
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

const db = openDb(dbPath);
const client = new TelegramClient(token, fetch, 45_000);

// ── Fallback chain state (shared across all dispatches) ───────────────────────

const fallbackChain = new WorkerFallbackChain(cliChain);
const exhaustedChats = new Set<string>();
// contextPreambles: set by dispatchWithFallback before retry; consumed + deleted by onBeforeExecute
const contextPreambles = new Map<string, string>();

// ── Bridge config ─────────────────────────────────────────────────────────────

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

// ── Build one engine per CLI kind ─────────────────────────────────────────────

const CLI_KINDS = ["codex", "claude", "antigravity"] as const;
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
          },
        },
        db,
        client,
      ),
    ];
  }),
) as Record<string, BridgeEngine>;

// ── setMyCommands ─────────────────────────────────────────────────────────────

await client.setMyCommands({ commands: buildWorkerCommands() })
  .catch((err: unknown) => console.warn("[worker-bot] setMyCommands failed", err));

console.log(`[worker-bot] starting (workerEnabled=${workerEnabled}, cliChain=${cliChain.join(",")})`);

let offset = 0;

for (;;) {
  try {
    const updates = await client.getUpdates({ offset, timeout: 30, allowed_updates: ["message"] });

    for (const update of (updates.result as any) ?? []) {
      const updateId: number = update.update_id;
      offset = updateId + 1;

      try {
        const message = (update as TelegramUpdate).message;
        if (!message) continue;
        if (!isAuthorizedMessage(message, allowedUserIds)) continue;

        const rawText = (message.text || "").trim();
        const chatId = message.chat.id;
        const chatKey = String(chatId);

        // Worker commands (/jobs, /issues, /review, /models) take priority
        if (isWorkerCommand(rawText)) {
          const result = handleWorkerCommand(rawText, { workerEnabled, cliChain });
          if (result) {
            const body = result.kind === "keyboard_message"
              ? { text: result.text, reply_markup: result.reply_markup }
              : { text: result.text };
            await sendTelegramMessage({ client, kind: "worker-bot", chatId, body });
          }
          continue;
        }

        // Plain message — record user turn, route to active CLI with fallback
        fallbackChain.addTurn(chatKey, "user", rawText);

        await dispatchWithFallback(update as TelegramUpdate, chatKey, {
          engines,
          fallbackChain,
          exhaustedChats,
          contextPreambles,
          notify: async (msg: string) => {
            await sendTelegramMessage({ client, kind: "worker-bot", chatId, body: { text: msg } });
          },
        });
      } catch (err) {
        console.error("[worker-bot] update handling failed", err);
      }
    }
  } catch (err) {
    console.error("[worker-bot] poll error", err);
    await new Promise(r => setTimeout(r, 5000));
  }
}
