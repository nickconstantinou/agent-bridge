import "dotenv/config";
import {
  buildGeminiFallbackInvocation,
  buildModelKeyboard,
  buildModelsText,
  createFileSessionStore,
  createFileSettingsStore,
  createSessionStore,
  extractPromptText,
  getCliWorkingDir,
  getBridgeProjectDir,
  handleCommand,
  isAuthorizedMessage,
  parseCliResult,
  buildCliInvocation,
  validateBridgeConfig,
  runCli,
} from "./bridge.js";
import { splitTelegramText, escapeTelegramMarkdownV2 } from "./render.js";
import { createTelegramOutbox } from "./outbox.js";
import { createBridgeState, createFileBridgeState } from "./state.js";
import { processTelegramUpdate } from "./updateLifecycle.js";

const config = {
  allowedUserId: process.env.TELEGRAM_ALLOWED_USER_ID,
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 1000),
  executionMode: process.env.BRIDGE_EXECUTION_MODE || "safe",
  cliTimeoutMs: Number(process.env.CLI_TIMEOUT_MS || 300000),
  geminiFallbackTimeoutMs: Number(process.env.GEMINI_FALLBACK_TIMEOUT_MS || 120000),
  sessionStorePath: process.env.SESSION_STORE_PATH || `${getBridgeProjectDir()}/.data/sessions.json`,
  settingsStorePath: process.env.SETTINGS_STORE_PATH || `${getBridgeProjectDir()}/.data/settings.json`,
  bots: {
    codex: {
      token: process.env.TELEGRAM_BOT_TOKEN_CODEX,
      command: process.env.CODEX_COMMAND || "codex",
      defaultModel: process.env.CODEX_MODEL || null,
    },
    gemini: {
      token: process.env.TELEGRAM_BOT_TOKEN_GEMINI,
      command: process.env.GEMINI_COMMAND || "gemini",
      defaultModel: process.env.GEMINI_MODEL || null,
    },
  },
};

const validation = validateBridgeConfig(config);
if (!validation.ok) {
  throw new Error(`Invalid bridge config:\n- ${validation.errors.join("\n- ")}`);
}

const sessionStore = createSessionStore(createFileSessionStore(config.sessionStorePath));
const settingsStore = createFileSettingsStore(config.settingsStorePath);
const bridgeState = createBridgeState(createFileBridgeState(process.env.BRIDGE_STATE_PATH || `${getBridgeProjectDir()}/.data/state.json`));
const outbox = createTelegramOutbox({ minIntervalMs: Number(process.env.OUTBOUND_MIN_INTERVAL_MS || 1100) });

console.log("[bridge] starting bots...");
await healBridgeState();

await Promise.all(
  Object.entries(config.bots)
    .filter(([, bot]) => bot.token)
    .map(([kind, bot]) => runBot(kind, bot)),
);

async function runBot(kind, bot) {
  let offset = (await bridgeState.getProcessedUpdateId(kind)) + 1;
  console.log(`[${kind}] bot online (offset: ${offset})`);

  for (;;) {
    try {
      const updates = await telegram(bot.token, "getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      });

      for (const update of updates.result ?? []) {
        offset = update.update_id + 1;
        try {
          await processTelegramUpdate(kind, update, bridgeState, (currentUpdate) => handleUpdate(kind, bot, currentUpdate));
        } catch (error) {
          console.error(`[${kind}] update handling failed`, error);
        }
      }

      if (!updates.result?.length) {
        await sleep(config.pollIntervalMs);
      }
    } catch (error) {
      console.error(`[${kind}] polling failed`, error);
      await sleep(Math.max(config.pollIntervalMs, 5000));
    }
  }
}

async function healBridgeState() {
  const state = await bridgeState.read();
  const healed = {
    ...state,
    processedUpdates: {
      codex: sanitizeCursor(state.processedUpdates?.codex),
      gemini: sanitizeCursor(state.processedUpdates?.gemini),
    },
  };

  if (healed.processedUpdates.codex !== state.processedUpdates?.codex || healed.processedUpdates.gemini !== state.processedUpdates?.gemini) {
    console.warn("[bridge] healing invalid processedUpdates state", state.processedUpdates, "->", healed.processedUpdates);
    await bridgeState.setProcessedUpdateId("codex", healed.processedUpdates.codex);
    await bridgeState.setProcessedUpdateId("gemini", healed.processedUpdates.gemini);
  }
}

function sanitizeCursor(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

async function handleUpdate(kind, bot, update) {
  if (update.callback_query) {
    await handleCallback(kind, bot, update.callback_query);
    return;
  }

  const message = update.message;
  if (!message) return;
  if (!isAuthorizedMessage(message, config.allowedUserId)) return;

  const prompt = extractPromptText(message);
  if (!prompt) return;

  const commandResponse = await handleCommand(kind, prompt, { settingsStore, sessionStore, config });
  if (commandResponse) {
    await sendTelegramText(bot.token, message.chat.id, { ...commandResponse });
    return;
  }

  const chatId = message.chat.id;
  const sessionId = await sessionStore.get(kind);

  try {
    const result = await executePrompt(kind, bot, prompt, sessionId);
    await sendTelegramText(bot.token, chatId, { text: result.text });
  } catch (error) {
    console.error(`[${kind}] prompt execution failed`, error);
    const message = String(error?.message || error);
    const text = message.slice(0, 4000);
    await sendTelegramText(bot.token, chatId, { text: `Error: ${text}` });
  }
}

async function executePrompt(kind, bot, prompt, sessionId) {
  const defaults = await settingsStore.read();
  const model = defaults[kind] || bot.defaultModel;
  const invocation = buildCliInvocation({ bot: kind, command: bot.command, model, prompt, sessionId, executionMode: config.executionMode });

  try {
    const stdout = await runCli(invocation.command, invocation.args, getCliWorkingDir(), { timeoutMs: config.cliTimeoutMs });
    const result = parseCliResult({ bot: kind, stdout });
    if (result.sessionId) await sessionStore.set(kind, result.sessionId);
    return result;
  } catch (error) {
    const message = String(error?.message || error);
    if (kind === "gemini" && sessionId && /Invalid session identifier/i.test(message)) {
      await sessionStore.set(kind, null);
      return executePrompt(kind, bot, prompt, null);
    }
    if (kind === "gemini" && /CLI timed out/i.test(message)) {
      const fallbackInvocation = buildGeminiFallbackInvocation({
        command: bot.command,
        model,
        prompt,
      });
      const fallbackStdout = await runCli(fallbackInvocation.command, fallbackInvocation.args, getCliWorkingDir(), { timeoutMs: config.geminiFallbackTimeoutMs });
      const fallbackResult = parseCliResult({ bot: kind, stdout: fallbackStdout });
      if (fallbackResult.sessionId) await sessionStore.set(kind, fallbackResult.sessionId);
      return {
        ...fallbackResult,
        text: `[Gemini timed out in tool mode, fell back to read-only mode]\n\n${fallbackResult.text}`,
      };
    }
    throw error;
  }
}

async function handleCallback(kind, bot, callbackQuery) {
  const fromId = callbackQuery?.from?.id;
  if (!isAuthorizedMessage({ from: { id: fromId } }, config.allowedUserId)) return;

  const data = String(callbackQuery?.data || "");
  const [action, targetKind, ...rest] = data.split(":");
  if (action !== "model" || targetKind !== kind) return;

  const value = rest.join(":").trim();
  const messageId = callbackQuery.message?.message_id;
  const chatId = callbackQuery.message?.chat?.id;
  if (!chatId) return;

  if (value === "reset") {
    await settingsStore.write({ [kind]: null });
    await telegram(bot.token, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: `${kind} reset` });
    await telegram(bot.token, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: await buildModelsText(kind, { settingsStore, config }),
      reply_markup: await buildModelKeyboard(kind),
    });
    return;
  }

  if (kind === "codex") {
    const allowed = new Set((await getCodexModels()).map((model) => model.slug));
    if (!allowed.has(value)) {
      await telegram(bot.token, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: `Unknown model: ${value}`, show_alert: true });
      return;
    }
  }

  await settingsStore.write({ [kind]: value });
  await telegram(bot.token, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: `${kind} set to ${value}` });
  await telegram(bot.token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: await buildModelsText(kind, { settingsStore, config }),
    reply_markup: await buildModelKeyboard(kind),
  });
}

async function telegram(token, method, body) {
  const payload = { ...body };
  if (payload.reply_markup && typeof payload.reply_markup === "object") {
    payload.reply_markup = JSON.stringify(payload.reply_markup);
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const detail = data?.description ? `: ${data.description}` : "";
    throw new Error(`Telegram HTTP ${response.status}${detail}`);
  }

  if (!data.ok) {
    throw new Error(data.description || `Telegram ${method} failed`);
  }
  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTelegramText(token, chatId, body) {
  const chunks = splitTelegramText(String(body.text || ""));
  const { text: _ignored, ...rest } = body;

  for (let i = 0; i < chunks.length; i += 1) {
    const chunkBody = {
      chat_id: chatId,
      ...rest,
      text: chunks[i],
      parse_mode: "MarkdownV2",
    };
    // Attempt MarkdownV2, fallback to plain text if it fails (likely due to bad escaping)
    try {
      const escapedText = escapeTelegramMarkdownV2(chunks[i]);
      chunkBody.text = escapedText;
      if (i > 0) delete chunkBody.reply_markup;
      await outbox.send(chatId, chunkBody, (message) => telegram(token, "sendMessage", message));
    } catch (error) {
      console.warn("[telegram] MarkdownV2 failed, falling back to plain text", error);
      const plainBody = { chat_id: chatId, ...rest, text: chunks[i] };
      if (i > 0) delete plainBody.reply_markup;
      await outbox.send(chatId, plainBody, (message) => telegram(token, "sendMessage", message));
    }
  }
}
