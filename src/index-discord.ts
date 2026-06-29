/**
 * PURPOSE: Entry point for the Discord bridge bot.
 * Creates a DiscordClient (WebSocket gateway + REST), wires it into BridgeEngine
 * per configured CLI kind, and forwards Discord MESSAGE_CREATE events as handleUpdate calls.
 *
 * Environment variables (see .env.discord.example):
 *   DISCORD_BOT_TOKEN          — required
 *   DISCORD_APPLICATION_ID     — required (for slash command registration)
 *   DISCORD_GUILD_ID           — optional; restricts command registration to one guild (instant)
 *   DISCORD_ALLOWED_USER_IDS   — comma-separated Discord snowflake user IDs
 *   DISCORD_CLI                — which CLI to run: codex | claude | antigravity (default: claude)
 *   CLI_COMMAND                — path/name of the CLI binary
 *   CLI_MODEL_PREFERENCE       — comma-separated model names
 *   DB_PATH                    — SQLite path for session/lock state
 *   BRIDGE_EXECUTION_MODE      — "safe" | "trusted"
 *   BRIDGE_ASYNC_ENABLED       — "true" | "false"
 *   POLL_INTERVAL_MS           — kept for consistency; unused (Discord is push-based)
 */

import dotenv from "dotenv";
import { getBridgeProjectDir, openDb, shutdownCliProcesses } from "./bridge.js";
import { DiscordClient, type DiscordUpdate } from "./discord.js";
import { discordMessageToTelegramUpdate, numericId } from "./discordAdapter.js";
import { BridgeEngine } from "./engine.js";
import { defaultSoulPath, loadSoulContext, normalizeSoulMode } from "./soul.js";
import type { TelegramUpdate } from "./types.js";

dotenv.config({
  path: process.env.BRIDGE_ENV_FILE || ".env.discord",
  override: false,
});

// ── Config ───────────────────────────────────────────────────────────────────

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error("DISCORD_BOT_TOKEN is required");

const applicationId = process.env.DISCORD_APPLICATION_ID;
if (!applicationId) throw new Error("DISCORD_APPLICATION_ID is required");

const allowedUserIds = new Set(
  (process.env.DISCORD_ALLOWED_USER_IDS || "")
    .split(",").map((s) => s.trim()).filter(Boolean),
);

const cliKind = (process.env.DISCORD_CLI || "claude") as "codex" | "claude" | "antigravity";
const cliCommand = process.env.CLI_COMMAND || cliKind;
const modelPreference = (process.env.CLI_MODEL_PREFERENCE || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const dbPath = process.env.DB_PATH || `${getBridgeProjectDir()}/.data/discord.sqlite`;
const executionMode = (process.env.BRIDGE_EXECUTION_MODE as "safe" | "trusted") || "safe";
const asyncEnabled = process.env.BRIDGE_ASYNC_ENABLED !== "false";

const soulContext = loadSoulContext({
  mode: normalizeSoulMode(process.env.AGENT_BRIDGE_SOUL_MODE),
  path: process.env.AGENT_BRIDGE_SOUL_PATH || defaultSoulPath(getBridgeProjectDir()),
});
if (soulContext) console.log(`[discord] loaded SOUL.md context (${soulContext.length} chars)`);

const db = openDb(dbPath);

// ── DiscordClient ─────────────────────────────────────────────────────────────

const client = new DiscordClient({
  token,
  applicationId,
  guildId: process.env.DISCORD_GUILD_ID,
  onUpdate: (update: DiscordUpdate) => {
    if (update.type === "INTERACTION_CREATE") {
      // Slash command — ACK immediately with deferred response (3-second window)
      handleInteraction(update.data).catch((err) =>
        console.error("[discord] interaction error", err),
      );
      return;
    }
    const telegramLike = discordMessageToTelegramUpdate(update, allowedUserIds);
    if (telegramLike) {
      engine.handleUpdate(telegramLike).catch((err) =>
        console.error("[discord] handleUpdate error", err),
      );
    }
  },
  onReady: () => console.log("[discord] gateway ready"),
  onError: (err) => console.error("[discord] gateway error", err),
});

// ── BridgeEngine ──────────────────────────────────────────────────────────────

const engine = new BridgeEngine(
  {
    kind: cliKind,
    botConfig: { command: cliCommand, modelPreference, token: undefined },
    allowedUserIds,
    executionMode,
    asyncEnabled,
    pollIntervalMs: 1_000,
    soulContext,
  },
  db,
  client,
);

// ── Start ─────────────────────────────────────────────────────────────────────

const shutdown = (signal: string) => {
  console.log(`[discord] ${signal} received, shutting down...`);
  client.destroy();
  shutdownCliProcesses();
  db.close();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log(`[discord] connecting gateway (CLI: ${cliKind})...`);
client.connect();

// Keep the process alive — gateway events drive execution
await new Promise(() => {});

/**
 * Handles a Discord INTERACTION_CREATE (slash command).
 * Must ACK within 3 seconds. We use type=5 (deferred channel message) then
 * follow up after CLI execution completes.
 */
async function handleInteraction(d: any): Promise<void> {
  const interactionId = d.id as string;
  const token = d.token as string;
  const userId = String(d.member?.user?.id ?? d.user?.id ?? "");
  const channelId = String(d.channel_id ?? "");
  const commandName = d.data?.name as string | undefined;
  const commandOptions = d.data?.options ?? [];

  if (!allowedUserIds.has(userId)) return;

  // Type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
  await client.answerCallbackQuery({
    interaction_id: interactionId,
    interaction_token: token,
    type: 5,
  }).catch((err) => console.warn("[discord] interaction ACK failed", err));

  // /reset and /stop are handled immediately without the CLI
  if (commandName === "reset" || commandName === "stop" || commandName === "cancel") {
    const chatId = numericId(channelId);
    await client.sendMessage({ chat_id: chatId, text: `/${commandName} received.` });
    return;
  }

  // Treat other slash commands as prompts to the CLI
  const promptOption = commandOptions.find((o: any) => o.name === "prompt" || o.name === "message");
  const promptText = promptOption?.value ?? commandName ?? "";
  if (!promptText) return;

  const chatId = numericId(channelId);
  const numericUserId = numericId(userId);
  const update: TelegramUpdate = {
    update_id: numericId(interactionId),
    message: {
      message_id: numericId(interactionId),
      chat: { id: chatId, type: d.guild_id ? "supergroup" : "private" },
      from: { id: numericUserId, first_name: d.member?.user?.username ?? d.user?.username ?? "User" },
      text: promptText,
    },
  };

  await engine.handleUpdate(update);
}
