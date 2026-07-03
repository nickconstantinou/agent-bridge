/**
 * PURPOSE: Entry point for agent bridge bots (Claude, Codex, Antigravity).
 * Bootstraps config, database, and per-bot BridgeEngine instances.
 * NEIGHBORS: src/engine.ts, src/bridge.ts, src/cli.ts, src/db.ts
 */

import dotenv from "dotenv";
import { basename } from "node:path";
import {
  validateBridgeConfig,
  getBridgeProjectDir,
  openDb,
  BridgeDb,
  shutdownCliProcesses,
} from "./bridge.js";
import { TelegramClient } from "./telegram.js";
import { BridgeEngine } from "./engine.js";
import { defaultSoulPath, loadSoulContext, normalizeSoulMode } from "./soul.js";
import { resolveTimeoutsForKind } from "./timeouts.js";
import type { BridgeConfig, BotConfig, BotKind } from "./types.js";
import { loadBotsConfig, validateTokenUniqueness } from "./config.js";

dotenv.config({
  path: process.env.BRIDGE_ENV_FILE || ".env",
  override: false,
});

function getServiceKindFromEnvFile(envPath: string): "codex" | "antigravity" | "claude" | "kimchi" | null {
  if (!envPath) return null;
  const name = basename(envPath);
  if (name.includes("codex")) return "codex";
  if (name.includes("antigravity")) return "antigravity";
  if (name.includes("gemini")) return "antigravity";
  if (name.includes("claude")) return "claude";
  if (name.includes("kimchi")) return "kimchi";
  return null;
}

const config: BridgeConfig = {
  allowedUserIds: new Set(
    (process.env.TELEGRAM_ALLOWED_USER_IDS || process.env.TELEGRAM_ALLOWED_USER_ID || "")
      .split(",").map(s => s.trim()).filter(Boolean)
  ),
  serviceEnvFile: process.env.BRIDGE_ENV_FILE || null,
  serviceKind: getServiceKindFromEnvFile(process.env.BRIDGE_ENV_FILE || ""),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 1000),
  executionMode: (process.env.BRIDGE_EXECUTION_MODE as "safe" | "trusted") || "safe",
  asyncEnabled: process.env.BRIDGE_ASYNC_ENABLED !== "false",
  dbPath: process.env.DB_PATH || `${getBridgeProjectDir()}/.data/bridge.sqlite`,
  bots: loadBotsConfig(process.env, { withTokens: true }),
};

validateTokenUniqueness(
  Object.fromEntries(Object.entries(config.bots).map(([kind, bot]) => [kind, bot.token]))
);

const validation = validateBridgeConfig(config);
if (!validation.ok) {
  throw new Error(`Invalid bridge config:\n- ${validation.errors.join("\n- ")}`);
}

const soulContext = loadSoulContext({
  mode: normalizeSoulMode(process.env.AGENT_BRIDGE_SOUL_MODE),
  path: process.env.AGENT_BRIDGE_SOUL_PATH || defaultSoulPath(getBridgeProjectDir()),
});
if (soulContext) console.log(`[bridge] loaded SOUL.md context (${soulContext.length} chars)`);

const db = openDb(config.dbPath);

console.log("[bridge] starting bots...");

const engines = (Object.entries(config.bots) as [BotKind, BotConfig][])
  .filter(([, bot]) => bot.token)
  .map(([kind, botConfig]) => {
    const client = new TelegramClient(botConfig.token!, fetch, resolveTimeoutsForKind(kind).fetchTimeoutMs);
    return new BridgeEngine(
      {
        kind,
        botConfig,
        allowedUserIds: config.allowedUserIds,
        executionMode: config.executionMode,
        asyncEnabled: config.asyncEnabled,
        pollIntervalMs: config.pollIntervalMs,
        soulContext,
        fullConfig: config,
      },
      db,
      client,
    );
  });

const shutdown = (signal: string) => {
  console.log(`[bridge] ${signal} received, shutting down...`);
  shutdownCliProcesses();
  db.close();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await Promise.all(engines.map((e) => e.run()));
