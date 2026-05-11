import type { BridgeConfig } from "./types.js";
import type { BridgeDb } from "./db.js";

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
): string | null {
  const text = String(prompt || "").trim();

  if (text === "/start") {
    return `${kind} bridge ready. use /models to change model, or just send a message to start a thread.`;
  }

  if (text === "/reset") {
    db.setSession(chatId, kind, null);
    return `${kind} session reset.`;
  }

  if (text === "/models") {
    const bot = config.bots[kind];
    const current = db.getSetting(kind) || bot.modelPreference[0] || "default";
    const available = bot.modelPreference.length > 0 ? bot.modelPreference.join(", ") : "none configured";
    return `Models for ${kind}:\n\nCurrent: ${current}\nAvailable: ${available}`;
  }

  return null;
}
