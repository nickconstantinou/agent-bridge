import { homedir } from "node:os";
import { runCli } from "./cli.js";
import { createFileStore, createMemoryStore } from "./store.js";

export function getBridgeRootDir() {
  return process.env.BRIDGE_ROOT_DIR || homedir();
}

export function getBridgeProjectDir() {
  return process.env.BRIDGE_PROJECT_DIR || `${getBridgeRootDir()}/.openclaw/workspace/projects/agent-bridge`;
}

export function getBotProjectDir(kind) {
  if (kind === "codex" && process.env.CODEX_PROJECT_DIR) return process.env.CODEX_PROJECT_DIR;
  if (kind === "gemini" && process.env.GEMINI_PROJECT_DIR) return process.env.GEMINI_PROJECT_DIR;
  return getBridgeProjectDir();
}

export function getCliWorkingDir() {
  return homedir();
}

export function isAuthorizedMessage(message, allowedUserId) {
  return String(message?.from?.id ?? "") === String(allowedUserId);
}

export function extractPromptText(message) {
  const text = message?.text?.trim();
  return text ? text : null;
}

export function getBotHelpText(kind) {
  return [
    `${kind} bridge ready`,
    `Send any normal message to chat with ${kind}.`,
    `Commands: /models, /model <name>, /model reset, /reset`,
  ].join("\n");
}

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

export function createFileSessionStore(filePath) {
  return createFileStore(filePath, { codex: null, gemini: null });
}

export function createFileSettingsStore(filePath) {
  return createFileStore(filePath, { codex: null, gemini: null });
}

let codexModelCatalogPromise = null;

export async function getCodexModels() {
  if (!codexModelCatalogPromise) {
    codexModelCatalogPromise = runCli("codex", ["debug", "models"], getCliWorkingDir())
      .then((stdout) => {
        const parsed = JSON.parse(stdout);
        return Array.isArray(parsed.models) ? parsed.models : [];
      })
      .catch(() => []);
  }

  return codexModelCatalogPromise;
}

export async function buildModelsText(kind, { settingsStore, config }) {
  const saved = (await settingsStore.read())[kind] || null;
  const fallback = config.bots[kind].defaultModel || null;
  const known = kind === "codex"
    ? (await getCodexModels()).map((model) => `${model.slug}${model.display_name ? ` (${model.display_name})` : ""}`).join(", ")
    : "gemini-2.0-flash-lite, gemini-2.0-pro-exp, gemini-2.0-flash-exp";
  return [
    `${kind} model settings`,
    `saved: ${saved || "(unset)"}`,
    `env: ${fallback || "(unset)"}`,
    `active: ${saved || fallback || "(unset)"}`,
    `known: ${known}`,
    `tap a button to set, or use /reset to clear session`,
  ].join("\n");
}

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
export { runCli, buildCliInvocation, buildExecutionOptions, buildGeminiFallbackInvocation, parseCliResult, validateBridgeConfig } from "./cli.js";
export { handleCommand } from "./commands.js";
export { createMemoryStore as createMemorySessionStore, createMemoryStore as createMemorySettingsStore } from "./store.js";
