import { homedir } from "node:os";
import { runCli, runCliAsync, parseCliResult, buildCliInvocation, validateBridgeConfig, buildExecutionOptions } from "./cli.js";
import { createFileStore, createMemoryStore } from "./store.js";
import type { TelegramMessage, Store, BridgeConfig } from "./types.js";

/**
 * Returns the root directory for the bridge.
 */
export function getBridgeProjectDir(): string {
  return process.env.BRIDGE_PROJECT_DIR || `${homedir()}/.openclaw/workspace/projects/agent-bridge`;
}

/**
 * Returns the working directory for the CLI.
 */
export function getCliWorkingDir(): string {
  return process.env.BRIDGE_ROOT_DIR || homedir();
}

/**
 * Authorization check for users.
 */
export function isAuthorizedMessage(message: TelegramMessage, allowedUserId: string): boolean {
  return String(message?.from?.id ?? "") === String(allowedUserId);
}

/**
 * Extracts the forum thread ID from a batch of messages, always using the
 * first message. Telegram guarantees messages[0] carries the thread context
 * even when later messages in a media group omit it.
 */
export function extractThreadId(messages: TelegramMessage[]): number | undefined {
  return messages[0]?.message_thread_id;
}

/**
 * Extract prompt text from message or caption.
 */
export function extractPromptText(message: TelegramMessage): string | null {
  const text = (message?.text || message?.caption || "").trim();
  if (!text) return null;
  // Ignore commands
  if (text.startsWith("/")) return null;
  return text;
}

/**
 * Creates a session store wrapper.
 */
export function createSessionStore(storeBackend: Store<Record<string, string | null>>) {
  return {
    async get(bot: string): Promise<string | null> {
      const data = await storeBackend.read();
      return data[bot] ?? null;
    },
    async set(bot: string, sessionId: string | null): Promise<void> {
      const current = await storeBackend.read();
      await storeBackend.write({ ...current, [bot]: sessionId });
    },
  };
}

/**
 * Creates a file-based session store.
 */
export function createFileSessionStore(filePath: string): Store<Record<string, string | null>> {
  return createFileStore(filePath, {});
}

/**
 * Creates a settings store.
 */
export function createFileSettingsStore(filePath: string): Store<Record<string, string | null>> {
  return createFileStore(filePath, {});
}

export function buildModelKeyboard(kind: string): any {
  // Logic to build inline keyboard for model selection
  return {
    inline_keyboard: [
      [{ text: "Reset to Default", callback_data: `model:${kind}:reset` }],
    ],
  };
}

export async function buildModelsText(kind: string, { settingsStore, config }: { settingsStore: Store<any>; config: BridgeConfig }): Promise<string> {
  const settings = await settingsStore.read();
  const current = settings[kind] || config.bots[kind as "codex" | "gemini"].defaultModel || "default";
  
  return `[${kind} model settings]\n\nCurrent: ${current}\n\nSelect a model below:`;
}

export { runCli, runCliAsync, parseCliResult, validateBridgeConfig, buildCliInvocation, buildExecutionOptions };
export { handleCommand } from "./commands.js";
export { createMemoryStore as createMemorySessionStore, createMemoryStore as createMemorySettingsStore } from "./store.js";
