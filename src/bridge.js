import { homedir } from "node:os";
import { runCli } from "./cli.js";
import { createFileStore, createMemoryStore } from "./store.js";

/**
 * Returns the root directory for the bridge.
 * @returns {string}
 */
export function getBridgeRootDir() {
  return process.env.BRIDGE_ROOT_DIR || homedir();
}

/**
 * Returns the project directory for the bridge.
 * @returns {string}
 */
export function getBridgeProjectDir() {
  return process.env.BRIDGE_PROJECT_DIR || process.cwd();
}

/**
 * Returns the project directory for a specific bot.
 * @param {string} kind - The bot kind ('codex' or 'gemini').
 * @returns {string}
 */
export function getBotProjectDir(kind) {
  if (kind === "codex" && process.env.CODEX_PROJECT_DIR) return process.env.CODEX_PROJECT_DIR;
  if (kind === "gemini" && process.env.GEMINI_PROJECT_DIR) return process.env.GEMINI_PROJECT_DIR;
  return getBridgeProjectDir();
}

/**
 * Returns the working directory for CLI execution.
 * @returns {string}
 */
export function getCliWorkingDir() {
  return homedir();
}

/**
 * Checks if a Telegram message is from an authorized user.
 * @param {object} message - The Telegram message object.
 * @param {string} allowedUserId - The authorized user ID.
 * @returns {boolean}
 */
export function isAuthorizedMessage(message, allowedUserId) {
  return String(message?.from?.id ?? "") === String(allowedUserId);
}

/**
 * Extracts the forum thread ID from a batch of messages, preferring the first message.
 * Using the first message is most reliable because Telegram guarantees it carries
 * the thread context even when later messages in a media group omit it.
 * @param {object[]} messages
 * @returns {number|undefined}
 */
export function extractThreadId(messages) {
  return messages[0]?.message_thread_id;
}

/**
 * Extracts prompt text from a Telegram message.
 * @param {object} message - The Telegram message object.
 * @returns {string|null}
 */
export function extractPromptText(message) {
  const text = message?.text?.trim();
  return text ? text : null;
}

/**
 * Returns help text for a bot.
 * @param {string} kind - The bot kind.
 * @returns {string}
 */
export function getBotHelpText(kind) {
  return [
    `${kind} bridge ready`,
    `Send any normal message to chat with ${kind}.`,
    `Commands: /models, /model <name>, /model reset, /reset`,
  ].join("\n");
}

/**
 * Creates a session store.
 * @param {object} storeBackend - The backend store (file or memory).
 * @returns {object}
 */
export function createSessionStore(storeBackend = createMemoryStore({ codex: null, gemini: null })) {
  return {
    async get(bot) {
      const data = await storeBackend.read();
      return data[bot] ?? null;
    },
    async set(bot, sessionId) {
      await storeBackend.write({ [bot]: sessionId ?? null });
    },
  };
}

/**
 * Creates a file-based session store.
 * @param {string} filePath - Path to the session file.
 * @returns {object}
 */
export function createFileSessionStore(filePath) {
  return createFileStore(filePath, { codex: null, gemini: null });
}

/**
 * Creates a file-based settings store.
 * @param {string} filePath - Path to the settings file.
 * @returns {object}
 */
export function createFileSettingsStore(filePath) {
  return createFileStore(filePath, { codex: null, gemini: null });
}

let codexModelCatalogPromise = null;

/**
 * Fetches available Codex models.
 * @returns {Promise<Array>}
 */
export async function getCodexModels() {
  if (!codexModelCatalogPromise) {
    codexModelCatalogPromise = runCli("codex", ["debug", "models"], getCliWorkingDir())
      .then((stdout) => {
        try {
          const parsed = JSON.parse(stdout);
          return Array.isArray(parsed.models) ? parsed.models : [];
        } catch {
          return [];
        }
      })
      .catch(() => []);
  }

  return codexModelCatalogPromise;
}

/**
 * Builds the text for the /models command.
 * @param {string} kind - The bot kind.
 * @param {object} deps - Dependencies (settingsStore, config).
 * @returns {Promise<string>}
 */
export async function buildModelsText(kind, { settingsStore, config }) {
  const saved = (await settingsStore.read())[kind] || null;
  const fallback = config.bots[kind].defaultModel || null;
  
  let known = "gemini-2.0-flash-lite, gemini-2.0-pro-exp, gemini-2.0-flash-exp";
  if (kind === "codex") {
    const models = await getCodexModels();
    known = models.length > 0 
      ? models.map((model) => `${model.slug}${model.display_name ? ` (${model.display_name})` : ""}`).join(", ")
      : "no models found";
  }

  return [
    `${kind} model settings`,
    `saved: ${saved || "(unset)"}`,
    `env: ${fallback || "(unset)"}`,
    `active: ${saved || fallback || "(unset)"}`,
    `known: ${known}`,
    `tap a button to set, or use /reset to clear session`,
  ].join("\n");
}

/**
 * Builds the inline keyboard for model selection.
 * @param {string} kind - The bot kind.
 * @returns {Promise<object>}
 */
export async function buildModelKeyboard(kind) {
  const rows = [];
  if (kind === "codex") {
    const models = await getCodexModels();
    for (let i = 0; i < models.length; i += 2) {
      rows.push(
        models.slice(i, i + 2).map((model) => ({
          text: model.display_name || model.slug,
          callback_data: `model:${kind}:${model.slug}`,
        })),
      );
    }
  } else {
    rows.push([
      { text: "gemini-2.0-flash-lite", callback_data: `model:${kind}:gemini-2.0-flash-lite` },
      { text: "gemini-2.0-pro-exp", callback_data: `model:${kind}:gemini-2.0-pro-exp` },
    ]);
  }
  rows.push([{ text: "Reset Model", callback_data: `model:${kind}:reset` }]);
  return { inline_keyboard: rows };
}

// Re-exporting from newer modules to maintain backward compatibility for tests
export { runCli, runCliAsync, buildCliInvocation, buildExecutionOptions,  parseCliResult, validateBridgeConfig } from "./cli.js";
export { handleCommand } from "./commands.js";
export { createMemoryStore as createMemorySessionStore, createMemoryStore as createMemorySettingsStore } from "./store.js";
