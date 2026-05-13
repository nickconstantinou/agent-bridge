import { homedir } from "node:os";
import { runCli, runCliAsync, parseCliResult, buildCliInvocation, validateBridgeConfig, buildExecutionOptions, isCapacityExhaustedError, getNextFallbackModel, abortCliProcess, shutdownCliProcesses } from "./cli.js";
import { openDb, BridgeDb } from "./db.js";
import type { TelegramMessage, BridgeConfig } from "./types.js";

export function getBridgeProjectDir(): string {
  return process.env.BRIDGE_PROJECT_DIR || `${homedir()}/.openclaw/workspace/projects/agent-bridge`;
}

export function getCliWorkingDir(bot?: "codex" | "gemini"): string {
  if (bot === "codex" && process.env.CODEX_PROJECT_DIR) return process.env.CODEX_PROJECT_DIR;
  if (bot === "gemini" && process.env.GEMINI_PROJECT_DIR) return process.env.GEMINI_PROJECT_DIR;
  return process.env.BRIDGE_PROJECT_DIR || process.env.BRIDGE_ROOT_DIR || homedir();
}

export function isAuthorizedMessage(message: TelegramMessage, allowedUserId: string): boolean {
  return String(message?.from?.id ?? "") === String(allowedUserId);
}

export function extractThreadId(messages: TelegramMessage[]): number | undefined {
  return messages[0]?.message_thread_id;
}

export function extractPromptText(message: TelegramMessage): string | null {
  const text = (message?.text || message?.caption || "").trim();
  if (!text) return null;
  if (text.startsWith("/")) return null;
  return text;
}

export function buildModelKeyboard(kind: string): any {
  return {
    inline_keyboard: [
      [{ text: "Reset to Default", callback_data: `model:${kind}:reset` }],
    ],
  };
}

export function buildModelsText(kind: string, { db, config }: { db: BridgeDb; config: BridgeConfig }): string {
  const bot = config.bots[kind as "codex" | "gemini"];
  const current = db.getSetting(kind) || bot.modelPreference[0] || "default";
  const available = bot.modelPreference.length > 0 ? bot.modelPreference.join(", ") : "none configured";
  return `[${kind} model settings]\n\nCurrent: ${current}\nAvailable: ${available}\n\nSelect a model below:`;
}

export { runCli, runCliAsync, parseCliResult, validateBridgeConfig, buildCliInvocation, buildExecutionOptions, isCapacityExhaustedError, getNextFallbackModel, abortCliProcess, shutdownCliProcesses };
export { openDb, BridgeDb };
export { handleCommand } from "./commands.js";
