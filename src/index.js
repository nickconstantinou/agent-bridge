import dotenv from "dotenv";
import {
  buildModelKeyboard,
  buildModelsText,
  createFileSessionStore,
  createFileSettingsStore,
  createSessionStore,
  extractPromptText,
  extractThreadId,
  getCliWorkingDir,
  getBridgeProjectDir,
  handleCommand,
  isAuthorizedMessage,
  parseCliResult,
  buildCliInvocation,
  validateBridgeConfig,
  runCli,
  runCliAsync,
} from "./bridge.js";
import { createTelegramOutbox } from "./outbox.js";
import { createBridgeState, createFileBridgeState } from "./state.js";
import { processTelegramUpdate } from "./updateLifecycle.js";
import { TelegramClient, MediaGroupBuffer } from "./telegram.js";
import { sendTelegramMessage, sendMessageWithProgress } from "./messageDelivery.js";

dotenv.config({
  path: process.env.BRIDGE_ENV_FILE || ".env",
  override: false,
});

function getServiceKindFromEnvFile(path) {
  if (!path) return null;
  if (path.includes(".env.codex")) return "codex";
  if (path.includes(".env.gemini")) return "gemini";
  return null;
}

const config = {
  allowedUserId: process.env.TELEGRAM_ALLOWED_USER_ID,
  serviceEnvFile: process.env.BRIDGE_ENV_FILE || null,
  serviceKind: getServiceKindFromEnvFile(process.env.BRIDGE_ENV_FILE || ""),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 1000),
  executionMode: process.env.BRIDGE_EXECUTION_MODE || "safe",
  cliTimeoutMs: Number(process.env.CLI_TIMEOUT_MS || 300000),
  // cliIdleTimeoutMs removed - typing provides liveness
  geminiFallbackTimeoutMs: Number(process.env.GEMINI_FALLBACK_TIMEOUT_MS || 120000),
  asyncEnabled: process.env.BRIDGE_ASYNC_ENABLED !== "false",
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
const bridgeState = createBridgeState(
  createFileBridgeState(process.env.BRIDGE_STATE_PATH || `${getBridgeProjectDir()}/.data/state.json`)
);
const outbox = createTelegramOutbox({
  minIntervalMs: Number(process.env.OUTBOUND_MIN_INTERVAL_MS || 1100),
});

class BridgeBot {
  constructor(kind, botConfig) {
    this.kind = kind;
    this.config = botConfig;
    this.client = new TelegramClient(botConfig.token);
    this.mediaBuffer = new MediaGroupBuffer({
      timeoutMs: 1500,
      onFlush: (groupId, messages) => {
        this.handleMessages(messages).catch((err) => {
          console.error(`[${this.kind}] mediaBuffer flush error`, err);
        });
      },
    });
  }

  async run() {
    const lockPath = `${getBridgeProjectDir()}/.data/telegram-${this.kind}.lock`;
    try {
      await this.client.acquireLease(lockPath);
    } catch (error) {
      console.error(`[${this.kind}] ${error.message}`);
      return;
    }

    let offset = (await bridgeState.getProcessedUpdateId(this.kind)) + 1;
    console.log(`[${this.kind}] bot online (offset: ${offset})`);

    for (;;) {
      try {
        const updates = await this.client.getUpdates({
          offset,
          timeout: 30,
          allowed_updates: ["message", "callback_query"],
        });

        for (const update of updates.result ?? []) {
          offset = update.update_id + 1;
          try {
            await processTelegramUpdate(this.kind, update, bridgeState, (currentUpdate) =>
              this.handleUpdate(currentUpdate)
            );
          } catch (error) {
            console.error(`[${this.kind}] update handling failed`, error);
          }
        }

        if (!updates.result?.length) {
          await sleep(config.pollIntervalMs);
        }
      } catch (error) {
        console.error(`[${this.kind}] polling failed`, error);
        await sleep(Math.max(config.pollIntervalMs, 5000));
      }
    }
  }

  async handleUpdate(update) {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }

    const message = update.message;
    if (!message) return;
    if (!isAuthorizedMessage(message, config.allowedUserId)) return;

    this.mediaBuffer.push(message);
  }

  async handleMessages(messages) {
    const primaryMessage = messages.find((m) => m.text || m.caption) || messages[0];

    const threadId = extractThreadId(messages);
    const prompt = extractPromptText(primaryMessage);
    if (!prompt) return;

    const commandResponse = await handleCommand(this.kind, prompt, {
      settingsStore,
      sessionStore,
      config,
    });
    if (commandResponse) {
      await this.sendText(primaryMessage.chat.id, { text: commandResponse, message_thread_id: threadId });
      return;
    }

    const chatId = primaryMessage.chat.id;
    const sessionId = await sessionStore.get(this.kind);

    // Choose async or sync based on config (sync is default)
    const useAsync = config.asyncEnabled === true;

    try {
      if (useAsync) {
        await sendMessageWithProgress({
          client: this.client,
          outbox,
          kind: this.kind,
          chatId,
          body: { message_thread_id: threadId },
          execution: (onProgress) =>
            this.executePromptAsync(prompt, sessionId, chatId, { message_thread_id: threadId }, onProgress),
        });
      } else {
        const result = await this.executePrompt(prompt, sessionId, chatId, { message_thread_id: threadId });
        await this.sendText(chatId, { text: result.text, message_thread_id: threadId });
      }
    } catch (error) {
      console.error(`[${this.kind}] prompt execution failed`, error);
      const messageText = String(error?.message || error);
      const text = messageText.slice(0, 4000);
      await sendTelegramMessage({
        client: this.client,
        outbox,
        kind: this.kind,
        chatId,
        body: { text: `Error: ${text}`, message_thread_id: threadId },
      });
    }
  }

  /**
   * Async prompt execution - sends immediate ack, streams progress, replaces placeholder, typing indicator.
   */
  async executePromptAsync(prompt, sessionId, chatId, body = {}, onProgress = () => {}) {
    const { message_thread_id: threadId } = body;
    const defaults = await settingsStore.read();
    const model = defaults[this.kind] || this.config.defaultModel;
    const invocation = buildCliInvocation({
      bot: this.kind,
      command: this.config.command,
      model,
      prompt,
      sessionId,
      executionMode: config.executionMode,
      outputFormat: "json", // Use json for better parsing and session ID extraction
    });

    const isCliTimeout = (error) => /CLI (idle timeout|timed out)/i.test(String(error?.message || error));

    // Start typing indicator
    const typingTracker = createTypingTracker(this.client, outbox, chatId, this.kind, { message_thread_id: threadId });
    await typingTracker.start();

    try {
      // Run with async CLI runner (no idle timeout - onProgress provides liveness)
      const cliResult = await runCliAsync(invocation.command, invocation.args, getCliWorkingDir(), {
        timeoutMs: config.cliTimeoutMs,
        idleTimeoutMs: null, // Disable idle timeout - onProgress callback proves liveness
        onProgress,
        onCancel: () => {}, // TODO: wire to cancel command
      });

      // Parse result
      const result = parseCliResult({ bot: this.kind, stdout: cliResult.text });
      if (result?.sessionId) await sessionStore.set(this.kind, result.sessionId);
      return result;
    } catch (error) {
      // No fallback - throw error directly
      throw error;
    } finally {
      await typingTracker.stop();
    }
  }

  async executePrompt(prompt, sessionId, chatId, body = {}) {
    const { message_thread_id: threadId } = body;
    const defaults = await settingsStore.read();
    const model = defaults[this.kind] || this.config.defaultModel;
    const streamGemini = this.kind === "gemini" && process.env.GEMINI_STREAM_JSON === "1";
    const invocation = buildCliInvocation({
      bot: this.kind,
      command: this.config.command,
      model,
      prompt,
      sessionId,
      executionMode: config.executionMode,
    });

    const typingTracker = createTypingTracker(this.client, outbox, chatId, this.kind, { message_thread_id: threadId });

    const isCliTimeout = (error) => /CLI (idle timeout|timed out)/i.test(String(error?.message || error));

    try {
      await typingTracker.start();
      const stdout = await runCli(invocation.command, invocation.args, getCliWorkingDir(), {
        timeoutMs: config.cliTimeoutMs,
        idleTimeoutMs: null, // Typing indicator provides liveness
      });
      let result;
      try {
        result = parseCliResult({ bot: this.kind, stdout });
      } catch (parseError) {
        // No fallback - throw parse error directly
        throw parseError;
      }
      if (result.sessionId) await sessionStore.set(this.kind, result.sessionId);
      return result;
    } catch (error) {
      // No fallback - throw error directly
      throw error;
    } finally {
      await typingTracker.stop();
    }
  }

  async handleCallback(callbackQuery) {
    const fromId = callbackQuery?.from?.id;
    if (!isAuthorizedMessage({ from: { id: fromId } }, config.allowedUserId)) return;

    const data = String(callbackQuery?.data || "");
    const [action, targetKind, ...rest] = data.split(":");
    if (action !== "model" || targetKind !== this.kind) return;

    const value = rest.join(":").trim();
    const messageId = callbackQuery.message?.message_id;
    const chatId = callbackQuery.message?.chat?.id;
    if (!chatId) return;

    if (value === "reset") {
      await settingsStore.write({ [this.kind]: null });
      await this.client.answerCallbackQuery({
        callback_query_id: callbackQuery.id,
        text: `${this.kind} reset`,
      });
      await this.client.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: await buildModelsText(this.kind, { settingsStore, config }),
        reply_markup: await buildModelKeyboard(this.kind),
      });
      return;
    }

    // Note: Codex model validation is skipped here for brevity, handled in commands.js
    // but kept consistent with existing logic if needed.

    await settingsStore.write({ [this.kind]: value });
    await this.client.answerCallbackQuery({
      callback_query_id: callbackQuery.id,
      text: `${this.kind} set to ${value}`,
    });
    await this.client.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text: await buildModelsText(this.kind, { settingsStore, config }),
      reply_markup: await buildModelKeyboard(this.kind),
    });
  }

  async sendText(chatId, body) {
    await sendTelegramMessage({ client: this.client, outbox, kind: this.kind, chatId, body });
  }
}

function createTypingTracker(client, outbox, chatId, kind, body = {}) {
  let timer = null;
  let active = false;
  const { message_thread_id: threadId } = body;

  const sendTyping = async () => {
    if (!active) return;
    try {
      await outbox.send(chatId, { chat_id: chatId, message_thread_id: threadId, action: "typing" }, (message) => client.sendChatAction(message));
    } catch (error) {
      console.warn(`[${kind}] typing indicator failed`, error.message);
    }
  };

  return {
    async start() {
      if (active) return;
      active = true;
      await sendTyping();
      timer = setInterval(() => {
        void sendTyping();
      }, 4500);
      timer.unref?.();
    },
    async stop() {
      active = false;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
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

  if (
    healed.processedUpdates.codex !== state.processedUpdates?.codex ||
    healed.processedUpdates.gemini !== state.processedUpdates?.gemini
  ) {
    console.warn(
      "[bridge] healing invalid processedUpdates state",
      state.processedUpdates,
      "->",
      healed.processedUpdates
    );
    await bridgeState.setProcessedUpdateId("codex", healed.processedUpdates.codex);
    await bridgeState.setProcessedUpdateId("gemini", healed.processedUpdates.gemini);
  }
}

function sanitizeCursor(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log("[bridge] starting bots...");
await healBridgeState();

const bots = Object.entries(config.bots)
  .filter(([, bot]) => bot.token)
  .map(([kind, botConfig]) => new BridgeBot(kind, botConfig));

const shutdown = async (signal) => {
  console.log(`[bridge] ${signal} received, releasing leases...`);
  await Promise.all(bots.map((bot) => bot.client.releaseLease()));
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await Promise.all(bots.map((bot) => bot.run()));
