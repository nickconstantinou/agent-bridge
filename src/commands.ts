/**
 * PURPOSE: Telegram bot commands routing and utility generation.
 * INPUTS: Chat messages and bot kind, configuration, and database instances.
 * OUTPUTS: A CommandResult specifying messages to send or prompt execution overrides.
 * NEIGHBORS: src/index.ts, src/bridge.ts, src/types.ts
 * LOGIC: Normalizes user commands and routes "/start", "/reset", "/models", "/skills" to appropriate action structures.
 */

import type { BridgeConfig } from "./types.js";
import type { BridgeDb } from "./db.js";
import { buildModelKeyboard, buildModelsText } from "./bridge.js";
import { listLocalCatalog } from "./skills.js";
import { buildEffortKeyboard, buildEffortText, resolveEffort } from "./effort.js";
import { contextInjectionPolicy, preseedCompactMode, preseedCompactCharThreshold } from "./contextPolicy.js";

const CONTEXT_COMPACT_NUDGE_TURNS = 100;

export type CommandResult =
  | { kind: "message"; text: string }
  | { kind: "keyboard_message"; text: string; reply_markup: any }
  | { kind: "execute"; prompt: string }
  | { kind: "codex_usage" }
  | { kind: "compact"; chatKey: string };

const bridgeCommands = new Set(["/start", "/reset", "/models", "/effort", "/skills", "/usage", "/narration", "/compact", "/context"]);

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

export function compactInProgressSettingKey(chatId: string): string {
  return `compact_in_progress:${chatId}`;
}

export function isAntigravityNarrationVisible(db: BridgeDb, chatId: string): boolean {
  return db.getSetting(antigravityNarrationSettingKey(chatId)) === "visible";
}

function handleNarrationCommand(kind: "codex" | "antigravity" | "claude" | "kimchi", text: string, db: BridgeDb, chatId: string): CommandResult {
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
  kind: "codex" | "antigravity" | "claude" | "kimchi",
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

  if (text === "/effort") {
    const current = resolveEffort(kind, db);
    return {
      kind: "keyboard_message",
      text: buildEffortText(kind, current),
      reply_markup: buildEffortKeyboard(kind, current),
    };
  }

  if (text === "/skills") {
    return {
      kind: "message",
      text: buildSkillsText(),
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
    const compactStartedAt = db.getSetting(compactInProgressSettingKey(chatId));
    const turnWord = status.turnCount === 1 ? "1 turn" : `${status.turnCount} turns`;
    const lines = [
      `**Context status** for \`${chatId}\``,
      `Stored: ${turnWord}`,
      `Pending queue: ${status.pendingCount}`,
      `Latest turn: ${status.latestTurnAt ?? "none"}`,
      `Latest compact: ${status.latestSummaryAt ?? "never"}`,
    ];
    if (compactStartedAt) {
      lines.push(`Compact: in progress since ${compactStartedAt}`);
    }
    if (summary) {
      const turnsSince = db.getRecentConvTurns(chatId, 1000, summary.range_end_turn_id).length;
      lines.push(`Turns since last compact: ${turnsSince}`);
    }
    if (status.turnCount > CONTEXT_COMPACT_NUDGE_TURNS) {
      lines.push("High turn count - consider /compact");
    }

    const policy = contextInjectionPolicy();
    const preseedMode = preseedCompactMode();
    const uncompacted = db.getUncompactedConvStats(chatId);
    const memoryCount = db.getMemoryCount();
    lines.push(
      "",
      `Injection policy: ${policy}`,
      `Pre-seed compact: ${preseedMode === "auto" ? `auto (threshold ${preseedCompactCharThreshold()} chars)` : "off"}`,
      `Uncompacted: ${uncompacted.turnCount} turns, ${uncompacted.charCount} chars`,
      `Memory count: ${memoryCount}`,
    );

    return { kind: "message", text: lines.join("\n") };
  }

  return null;
}

export function buildTelegramCommands(kind: "codex" | "antigravity" | "claude" | "kimchi"): Array<{ command: string; description: string }> {
  const commands = [
    { command: "models",   description: "Switch model" },
    { command: "effort",   description: "Switch reasoning effort" },
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
