import type { Store, BridgeConfig } from "./types.js";

/**
 * Handle bot commands.
 */
export async function handleCommand(
  kind: "codex" | "gemini",
  prompt: string,
  {
    settingsStore,
    sessionStore,
    config,
  }: {
    settingsStore: Store<any>;
    sessionStore: any;
    config: BridgeConfig;
  }
): Promise<string | null> {
  const text = String(prompt || "").trim();

  if (text === "/start") {
    return `${kind} bridge ready. use /models to change model, or just send a message to start a thread.`;
  }

  if (text === "/reset") {
    await sessionStore.set(kind, null);
    return `${kind} session reset.`;
  }

  if (text === "/models") {
    return `Models for ${kind}:\n\n${await buildModelsText(kind, { settingsStore, config })}`;
  }

  return null;
}

async function buildModelsText(kind: string, { settingsStore, config }: { settingsStore: Store<any>; config: BridgeConfig }) {
  const defaults = await settingsStore.read();
  const current = defaults[kind] || config.bots[kind as "codex" | "gemini"].defaultModel || "default";
  return `Current model: ${current}\n\nAvailable models: soon...`;
}
