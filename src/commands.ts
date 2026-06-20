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
  | { kind: "execute"; prompt: string }
  | { kind: "codex_usage" }
  | { kind: "compact"; chatKey: string }
  | { kind: "context_status"; chatKey: string };

const bridgeCommands = new Set(["/start", "/reset", "/models", "/skills", "/memory", "/usage", "/narration", "/compact", "/context"]);

function normalizeCommand(text: string): string {
  const [command] = String(text || "").trim().toLowerCase().split(/\s+/, 1);
  return command.replace(/@\S+$/, "");
}

export function isBridgeCommand(text: string): boolean {
  return bridgeCommands.has(normalizeCommand(text));
}

export function antigravityNarrationSettingKey(chatId: string): string {
  return `antigravity:narration:${chatId}`;
}

export function isAntigravityNarrationVisible(db: BridgeDb, chatId: string): boolean {
  return db.getSetting(antigravityNarrationSettingKey(chatId)) === "visible";
}

function handleNarrationCommand(kind: "codex" | "antigravity" | "claude", text: string, db: BridgeDb, chatId: string): CommandResult {
  if (kind !== "antigravity") {
    return { kind: "message", text: "/narration is only available on Antigravity." };
  }

  const [, rawMode = "status"] = String(text || "").trim().toLowerCase().split(/\s+/, 2);
  const key = antigravityNarrationSettingKey(chatId);
  const current = isAntigravityNarrationVisible(db, chatId);
  const next =
    rawMode === "on" || rawMode === "visible" ? true :
    rawMode === "off" || rawMode === "hidden" ? false :
    rawMode === "toggle" ? !current :
    current;

  if (!["on", "visible", "off", "hidden", "toggle", "status"].includes(rawMode)) {
    return { kind: "message", text: "Usage: /narration on|off|status" };
  }

  if (rawMode !== "status") {
    db.setSetting(key, next ? "visible" : "hidden");
  }

  return {
    kind: "message",
    text: next
      ? "Agy narration is visible. STATUS updates may appear while Antigravity works."
      : "Agy narration is hidden. STATUS updates only refresh typing.",
  };
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

  if (text === "/narration") {
    return handleNarrationCommand(kind, prompt, db, chatId);
  }

  if (text === "/usage") {
    if (kind !== "codex") {
      return {
        kind: "message",
        text: "/usage is only available on the Codex bridge.",
      };
    }
    return { kind: "codex_usage" };
  }

  if (text === "/compact") {
    return { kind: "compact", chatKey: chatId };
  }

  if (text === "/context") {
    const status = db.getConvStatus(chatId);
    const summary = db.getLatestConvSummary(chatId);
    const turnWord = status.turnCount === 1 ? "1 turn" : `${status.turnCount} turns`;
    const lines = [
      `**Context status** for \`${chatId}\``,
      `Stored: ${turnWord}`,
      `Pending queue: ${status.pendingCount}`,
      `Latest turn: ${status.latestTurnAt ?? "none"}`,
      `Latest compact: ${status.latestSummaryAt ?? "never"}`,
    ];
    if (summary) {
      const turnsSince = db.getRecentConvTurns(chatId, 1000, summary.range_end_turn_id).length;
      lines.push(`Turns since last compact: ${turnsSince}`);
    }
    return { kind: "message", text: lines.join("\n") };
  }

  return null;
}

export function buildTelegramCommands(kind: "codex" | "antigravity" | "claude"): Array<{ command: string; description: string }> {
  const commands = [
    { command: "models",   description: "Switch model" },
    { command: "reset",    description: "Clear current session" },
    { command: "stop",     description: "Abort running execution" },
    { command: "compact",  description: "Compact conversation context" },
    { command: "context",  description: "Show context status" },
  ];

  if (kind === "codex") {
    commands.push({ command: "usage", description: "Show Codex plan usage" });
  }
  if (kind === "antigravity") {
    commands.push({ command: "narration", description: "Toggle Agy narration visibility" });
  }

  return commands;
}
