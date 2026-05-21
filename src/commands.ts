/**
 * PURPOSE: Telegram bot commands routing and utility generation (e.g. models selection and memory smoke tests).
 * INPUTS: Chat messages and bot kind, configuration, and database instances.
 * OUTPUTS: A CommandResult specifying messages to send or prompt execution overrides.
 * NEIGHBORS: src/index.ts, src/bridge.ts, src/types.ts
 * LOGIC: Normalizes user commands and routes "/start", "/reset", "/models", "/skills", "/memory" to appropriate action structures.
 */

import type { BridgeConfig } from "./types.js";
import type { BridgeDb } from "./db.js";
import { buildModelKeyboard, buildModelsText } from "./bridge.js";
import { listLocalCatalog } from "./skills.js";

export type CommandResult =
  | { kind: "message"; text: string }
  | { kind: "keyboard_message"; text: string; reply_markup: any }
  | { kind: "execute"; prompt: string };

const bridgeCommands = new Set(["/start", "/reset", "/models", "/skills", "/memory"]);

function normalizeCommand(text: string): string {
  return String(text || "").trim().toLowerCase().replace(/@\S+$/, "");
}

export function isBridgeCommand(text: string): boolean {
  return bridgeCommands.has(normalizeCommand(text));
}

function buildMemorySmokePrompt(kind: "codex" | "antigravity" | "claude"): string {
  return [
    `Run a shared memory smoke test for the ${kind} bridge session.`,
    `Use the local agent-memory CLI from the shell if needed.`,
    `1. Run agent-memory recall with a query relevant to agent-bridge.`,
    `2. Do not write or modify memory during this test.`,
    `3. Reply in exactly this format:`,
    `MEMORY_AVAILABLE: yes|no`,
    `TOOL_USED: <tool-name-or-none>`,
    `RESULT_SUMMARY: <short summary>`,
    `ERROR: <none-or-short error>`,
  ].join("\n");
}

function buildSkillsText(): string {
  const skills = listLocalCatalog();
  if (skills.length === 0) return "No bundled agent-bridge skills were found.";

  return [
    "Bundled agent-bridge skills:",
    ...skills.map((skill) => `- ${skill.name} - ${skill.description}`),
    "",
    "Install or repair locally:",
    "npm run skills -- install <skill-name>",
    "npm run skills -- verify --fix",
  ].join("\n");
}

export function handleCommand(
  kind: "codex" | "antigravity" | "claude",
  prompt: string,
  {
    db,
    chatId,
    config,
  }: {
    db: BridgeDb;
    chatId: string;
    config: BridgeConfig;
  }
): CommandResult | null {
  const text = normalizeCommand(prompt);

  if (text === "/start") {
    return {
      kind: "message",
      text: `${kind} bridge ready. use /models to change model, or just send a message to start a thread.`,
    };
  }

  if (text === "/reset") {
    db.setSession(chatId, kind, null);
    return { kind: "message", text: `${kind} session reset.` };
  }

  if (text === "/models") {
    const bot = config.bots[kind];
    return {
      kind: "keyboard_message",
      text: buildModelsText(kind, { db, config }),
      reply_markup: buildModelKeyboard(kind, bot.modelPreference, db.getSetting(kind)),
    };
  }

  if (text === "/skills") {
    return {
      kind: "message",
      text: buildSkillsText(),
    };
  }

  if (text === "/memory") {
    return {
      kind: "execute",
      prompt: buildMemorySmokePrompt(kind),
    };
  }

  return null;
}
