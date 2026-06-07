/**
 * PURPOSE: Entry point for the unified interactive bot.
 * One Telegram bot polls for messages; each message is routed to the user's
 * preferred CLI engine (codex | claude | antigravity). /switch and /cli
 * commands change the active CLI without losing existing sessions.
 * NEIGHBORS: src/interactiveBot.ts, src/engine.ts, src/bridge.ts, src/db.ts
 */

import dotenv from "dotenv";
import { execFileSync } from "node:child_process";
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
import { isAuthorizedMessage, extractPromptText } from "./bridge.js";
import {
  getUserCliPreference,
  setUserCliPreference,
  parseCliSwitchCommand,
  buildCliStatusText,
  buildInteractiveCommands,
  resolveUpdateChatKey,
  isAuthorizedInteractiveUpdate,
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

function parseModelPreference(raw: string | undefined): string[] {
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

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
const client = new TelegramClient(token, fetch, 30_000);

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
        },
        db,
        client,
      ),
    ];
  }),
) as Record<CliKind, BridgeEngine>;

function killOrphanedCli(kind: CliKind, command: string): void {
  const patterns: Record<CliKind, string> = {
    codex: `${command} exec`,
    antigravity: `${command} --dangerously-skip-permissions`,
    claude: `${command} --print`,
  };
  try {
    execFileSync("pkill", ["-f", patterns[kind]], { stdio: "ignore" });
  } catch { /* no processes matched */ }
}

for (const kind of CLI_KINDS) {
  killOrphanedCli(kind, config.bots[kind as BotKind].command);
}

const defaultPref = getUserCliPreference(db, "default");
await client.setMyCommands({ commands: buildInteractiveCommands(defaultPref) })
  .catch((err: unknown) => console.warn("[interactive] setMyCommands failed", err));

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
        if (!isAuthorizedInteractiveUpdate(update as TelegramUpdate, allowedUserIds)) continue;

        // Handle /switch and /cli before engine dispatch
        const message = (update as TelegramUpdate).message;
        if (message) {
          const rawText = (message.text || "").trim();
          const chatId = message.chat.id;
          const chatKey = String(chatId);

          if (rawText.toLowerCase() === "/cli") {
            const pref = getUserCliPreference(db, chatKey);
            await sendTelegramMessage({ client, kind: "interactive", chatId, body: { text: buildCliStatusText(pref) } });
            continue;
          }

          const switchResult = parseCliSwitchCommand(rawText);
          if (switchResult !== null) {
            if (switchResult.ok) {
              setUserCliPreference(db, chatKey, switchResult.cli);
              await client.setMyCommands({ commands: buildInteractiveCommands(switchResult.cli) })
                .catch((err: unknown) => console.warn("[interactive] setMyCommands failed after /switch", err));
              await sendTelegramMessage({ client, kind: "interactive", chatId, body: {
                text: `Switched to **${switchResult.cli}**.\n${buildCliStatusText(switchResult.cli)}`,
              } });
            } else {
              await sendTelegramMessage({ client, kind: "interactive", chatId, body: { text: switchResult.error } });
            }
            continue;
          }
        }

        // Route to the user's preferred engine, resolved from message or callback_query
        const chatKey = resolveUpdateChatKey(update as TelegramUpdate);
        const pref = chatKey ? getUserCliPreference(db, chatKey) : "codex";
        await engines[pref].handleUpdate(update as TelegramUpdate);
      } catch (err) {
        console.error("[interactive] update handling failed", err);
      }
    }
  } catch (err) {
    console.error("[interactive] poll error", err);
    await new Promise(r => setTimeout(r, 5000));
  }
}
