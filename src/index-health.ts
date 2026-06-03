/**
 * PURPOSE: Entry point for the dedicated health monitoring bot service.
 * Runs independently from the main bridge bots — uses its own Telegram bot token,
 * its own SQLite DB, and has no shared state with agent-bridge-claude/codex/antigravity services.
 */

import dotenv from "dotenv";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { TelegramClient } from "./telegram.js";
import { HealthScheduler } from "./health/scheduler.js";
import { HealthBridgeBot } from "./health/bot.js";
import { SelfPlugin } from "./health/plugins/self.js";
import { ExternalPlugin } from "./health/plugins/external.js";
import { parseHealthEnabled, parseCadenceSeconds } from "./health/config.js";
import { sendTelegramMessage } from "./messageDelivery.js";
import { createPollErrorState, planPollError, notePollSuccess } from "./polling.js";
import { buildCliInvocation, runCli, parseCliResult } from "./cli.js";
import { BridgeDb } from "./db.js";
import type { BotKind } from "./types.js";
import type { HealthPlugin } from "./health/types.js";

// ── Config ──────────────────────────────────────────────────────────────────
if (process.env.BRIDGE_ENV_FILE) {
  dotenv.config({ path: process.env.BRIDGE_ENV_FILE, override: false });
}

const token = process.env.TELEGRAM_BOT_TOKEN_HEALTH;
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN_HEALTH is required for the health bot service");
}

const allowedUserIds = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",").map(s => s.trim()).filter(Boolean)
);
if (!allowedUserIds.size) {
  throw new Error("TELEGRAM_ALLOWED_USER_IDS is required");
}

const chatId = process.env.HEALTH_MONITOR_CHAT_ID
  ? Number(process.env.HEALTH_MONITOR_CHAT_ID)
  : null;

const healthEnabled = parseHealthEnabled(process.env);
const cadenceSeconds = parseCadenceSeconds(process.env);
const autonomy = (process.env.HEALTH_MONITOR_AUTONOMY as "report" | "suggest" | "auto") || "report";
const sessionTtlSeconds = Number(process.env.HEALTH_SESSION_TTL_SECONDS) > 0
  ? Number(process.env.HEALTH_SESSION_TTL_SECONDS)
  : 1800;

const cliBot = (process.env.HEALTH_CLI_BOT || "claude") as BotKind;
const cliBotConfig = {
  command: process.env.HEALTH_CLI_COMMAND || "claude",
  modelPreference: (process.env.HEALTH_CLI_MODEL_PREFERENCE || "")
    .split(",").map(s => s.trim()).filter(Boolean),
};

const dbPath = process.env.HEALTH_DB_PATH || ".data-health/health.sqlite";

// ── Infrastructure ───────────────────────────────────────────────────────────
mkdirSync(dirname(dbPath), { recursive: true });
const rawDb = new Database(dbPath);
rawDb.pragma("journal_mode = WAL");
const bridgeDb = new BridgeDb(rawDb);
const client = new TelegramClient(token, fetch);

const sendText = async (text: string): Promise<void> => {
  if (!chatId) {
    console.log(`[health-bot] no HEALTH_MONITOR_CHAT_ID, dropping message:\n${text}`);
    return;
  }
  await sendTelegramMessage({ client, kind: "health", chatId, body: { text } });
};

// ── Health bot ───────────────────────────────────────────────────────────────
const healthBot = new HealthBridgeBot({
  db: rawDb,
  chatId: chatId ?? 0,
  sessionTtlSeconds,
  autonomy,
  cliBot,
  cliBotConfig,
  _sendText: sendText,
});

// ── Health plugins ───────────────────────────────────────────────────────────
const plugins: HealthPlugin[] = [new SelfPlugin(bridgeDb, dbPath)];

if (process.env.HEALTH_CONTENT_CRAWLER_ENABLED === "1") {
  const script = process.env.HEALTH_CONTENT_CRAWLER_SCRIPT
    || `${process.env.HOME}/content-crawler/scripts/health_check.py`;
  const python = `${process.env.HOME}/content-crawler/venv/bin/python3`;
  plugins.push(new ExternalPlugin({ name: "content-crawler", command: python, args: [script], timeoutMs: 30_000 }));
  console.log(`[health-bot] content-crawler plugin enabled: ${script}`);
}

// ── Scheduler ────────────────────────────────────────────────────────────────
const scheduler = new HealthScheduler({
  plugins,
  config: {
    enabled: healthEnabled,
    cadenceSeconds,
    autonomy: "report", // scheduler only sends formatted report; bot handles suggestions
  },
  sendReport: async (text) => {
    if (!chatId) {
      console.log(`[health-bot] report (no chatId):\n${text}`);
    }
    // Raw report handling is done via onRawReport — this path is for any fallback text
  },
  onRawReport: async (report) => {
    await healthBot.handleReport(report);
  },
});

// ── Telegram polling ─────────────────────────────────────────────────────────
let offset = 0;
const pollErrState = createPollErrorState();
const defaultSleepMs = 5000;

async function processMessage(text: string, fromUserId: number): Promise<void> {
  if (!allowedUserIds.has(String(fromUserId))) return;
  if (!chatId) return;

  const trimmed = text.trim();

  if (trimmed === "/health") {
    await sendText("Checking health...");
    for (const plugin of plugins) {
      const report = await plugin.check();
      await healthBot.handleReport(report);
    }
    return;
  }

  if (trimmed === "/status") {
    const { HealthContextStore } = await import("./health/context.js");
    const store = new HealthContextStore(rawDb);
    const context = store.getContext();
    if (!context?.lastReport) {
      await sendText("No health data yet. Use /health to run a check.");
      return;
    }
    const { formatReport } = await import("./health/reporter.js");
    let statusText = formatReport(context.lastReport);
    if (context.lastSuggestion) {
      statusText += `\n\n*Last suggestion:*\n\n${context.lastSuggestion}`;
    }
    await sendText(statusText);
    return;
  }

  // Any other message — route to CLI with context prefix
  const prompt = healthBot.buildOnDemandPrompt(trimmed);
  const sessionId = healthBot.getActiveSessionId();

  const invocation = buildCliInvocation({
    bot: cliBot,
    command: cliBotConfig.command,
    model: cliBotConfig.modelPreference[0] ?? null,
    prompt,
    sessionId,
    executionMode: "safe",
    outputFormat: cliBot !== "antigravity" ? "json" : null,
  });

  try {
    await sendText("Working...");
    const stdout = await runCli(invocation.command, invocation.args, process.cwd(), {
      timeoutMs: 600_000,
      chatId: `health-chat-${fromUserId}`,
    });
    const result = parseCliResult({ bot: cliBot, stdout, logContent: null });
    if (result.sessionId) healthBot.saveSession(result.sessionId);
    await sendText(result.text || "No response.");
  } catch (err) {
    console.error("[health-bot] CLI error", err);
    await sendText("CLI error — check logs.");
  }
}

async function poll(): Promise<void> {
  for (;;) {
    try {
      const updates = await client.getUpdates({ offset, timeout: 30, allowed_updates: ["message"] });
      notePollSuccess(pollErrState);

      for (const update of (updates.result ?? [])) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text || !msg.from) continue;
        processMessage(msg.text, msg.from.id).catch((err: unknown) =>
          console.error("[health-bot] message error", err)
        );
      }
    } catch (err: unknown) {
      const plan = planPollError(err, pollErrState, defaultSleepMs);
      await new Promise(r => setTimeout(r, plan.sleepMs));
    }
  }
}

// ── Start ────────────────────────────────────────────────────────────────────
console.log("[health-bot] starting...");

if (healthEnabled) {
  scheduler.start();
  // Fire immediately on startup
  for (const plugin of plugins) {
    plugin.check().then(report => healthBot.handleReport(report)).catch((err: unknown) =>
      console.error("[health-bot] startup check error", err)
    );
  }
  console.log(`[health-bot] scheduler started — cadence ${cadenceSeconds}s, autonomy=${autonomy}`);
}

const shutdown = (signal: string) => {
  console.log(`[health-bot] ${signal} received, shutting down...`);
  scheduler.stop();
  rawDb.close();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await poll();
