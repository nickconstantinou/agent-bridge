/**
 * PURPOSE: Entry point for the autonomous worker bot.
 * Handles /jobs, /issues, /review commands. Routes job execution through a
 * CLI fallback chain (codex → claude → antigravity). Phase 0: stubs only —
 * WORKER_ENABLED=false means no execution occurs.
 * NEIGHBORS: src/workerBot.ts, src/engine.ts, src/db.ts
 */

import dotenv from "dotenv";
import {
  getBridgeProjectDir,
  openDb,
  isAuthorizedMessage,
  shutdownCliProcesses,
} from "./bridge.js";
import { TelegramClient } from "./telegram.js";
import { sendTelegramMessage } from "./messageDelivery.js";
import { handleWorkerCommand, isWorkerCommand } from "./workerBot.js";
import type { TelegramUpdate } from "./types.js";

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
const dbPath = process.env.DB_PATH || `${getBridgeProjectDir()}/.data/bridge.sqlite`;
const db = openDb(dbPath);
const client = new TelegramClient(token, fetch, 30_000);

console.log(`[worker-bot] starting (workerEnabled=${workerEnabled})`);

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
        if (!isWorkerCommand(rawText)) continue;

        const result = handleWorkerCommand(rawText, { workerEnabled });
        if (result) {
          await sendTelegramMessage({ client, kind: "worker-bot", chatId: message.chat.id, body: { text: result.text } });
        }
      } catch (err) {
        console.error("[worker-bot] update handling failed", err);
      }
    }
  } catch (err) {
    console.error("[worker-bot] poll error", err);
    await new Promise(r => setTimeout(r, 5000));
  }
}
