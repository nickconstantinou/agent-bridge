import type { BridgeConfig } from "./types.js";
import type { BridgeDb } from "./db.js";
import { buildModelKeyboard, buildModelsText } from "./bridge.js";

export type CommandResult =
  | { kind: "message"; text: string }
  | { kind: "keyboard_message"; text: string; reply_markup: any }
  | { kind: "execute"; prompt: string };

const bridgeCommands = new Set(["/start", "/reset", "/models", "/memory"]);

export function isBridgeCommand(text: string): boolean {
  return bridgeCommands.has(String(text || "").trim().toLowerCase());
}

function buildMemorySmokePrompt(kind: "codex" | "gemini"): string {
  return [
    `Run a shared memory smoke test for the ${kind} bridge session.`,
    `Use the shared memory MCP tools directly.`,
    `1. Call search_knowledge with project_id: "server" and a query relevant to agent-bridge.`,
    `2. Do not write or modify memory during this test.`,
    `3. Reply in exactly this format:`,
    `MCP_AVAILABLE: yes|no`,
    `TOOL_USED: <tool-name-or-none>`,
    `RESULT_SUMMARY: <short summary>`,
    `ERROR: <none-or-short error>`,
  ].join("\n");
}

export function handleCommand(
  kind: "codex" | "gemini",
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
  const text = String(prompt || "").trim();

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
      reply_markup: buildModelKeyboard(kind, bot.modelPreference),
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
