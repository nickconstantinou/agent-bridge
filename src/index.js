import dotenv from "dotenv";
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
import { createTelegramOutbox } from "./outbox.js";
import { createBridgeState, createFileBridgeState } from "./state.js";
import { processTelegramUpdate } from "./updateLifecycle.js";
import { TelegramClient } from "./telegram.js";
import { sendTelegramMessage } from "./messageDelivery.js";

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
  cliIdleTimeoutMs: Number(process.env.CLI_IDLE_TIMEOUT_MS || 60000),
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
  }

  async run() {
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

    const prompt = extractPromptText(message);
    if (!prompt) return;

  const commandResponse = await handleCommand(this.kind, prompt, {
      settingsStore,
      sessionStore,
      config,
    });
    if (commandResponse) {
      await this.sendText(message.chat.id, commandResponse);
      return;
    }

    const chatId = message.chat.id;
    const sessionId = await sessionStore.get(this.kind);

    try {
      const result = await this.executePrompt(prompt, sessionId, chatId);
      await this.sendText(chatId, { text: result.text });
    } catch (error) {
      console.error(`[${this.kind}] prompt execution failed`, error);
      const messageText = String(error?.message || error);
      const text = messageText.slice(0, 4000);
      await this.sendText(chatId, { text: `Error: ${text}` });
    }
  }

  async executePrompt(prompt, sessionId, chatId) {
    const defaults = await settingsStore.read();
    const model = defaults[this.kind] || this.config.defaultModel;
    const invocation = buildCliInvocation({
      bot: this.kind,
      command: this.config.command,
      model,
      prompt,
      sessionId,
      executionMode: config.executionMode,
    });

    const typingTracker = createTypingTracker(this.client, outbox, chatId, this.kind);

    try {
      await typingTracker.start();
      const stdout = await runCli(invocation.command, invocation.args, getCliWorkingDir(), {
        timeoutMs: config.cliTimeoutMs,
        idleTimeoutMs: config.cliIdleTimeoutMs,
      });
      const result = parseCliResult({ bot: this.kind, stdout });
      if (result.sessionId) await sessionStore.set(this.kind, result.sessionId);
      return result;
    } catch (error) {
      const message = String(error?.message || error);
      if (this.kind === "gemini" && sessionId && error?.isCliError && /Invalid session identifier/i.test(message)) {
        await sessionStore.set(this.kind, null);
        return this.executePrompt(prompt, null);
      }
      if (this.kind === "gemini" && /CLI timed out/i.test(message)) {
        const fallbackInvocation = buildGeminiFallbackInvocation({
          command: this.config.command,
          model,
          prompt,
        });
        const fallbackStdout = await runCli(
          fallbackInvocation.command,
          fallbackInvocation.args,
          getCliWorkingDir(),
          { timeoutMs: config.geminiFallbackTimeoutMs, idleTimeoutMs: config.cliIdleTimeoutMs, killGraceMs: 5000 }
        );
        const fallbackResult = parseCliResult({ bot: this.kind, stdout: fallbackStdout });
        if (fallbackResult.sessionId) await sessionStore.set(this.kind, fallbackResult.sessionId);
        return {
          ...fallbackResult,
          text: `[Gemini timed out in tool mode, fell back to read-only mode]\n\n${fallbackResult.text}`,
        };
      }
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

function createTypingTracker(client, outbox, chatId, kind) {
  let timer = null;
  let active = false;

  const sendTyping = async () => {
    if (!active) return;
    try {
      await outbox.send(chatId, { chat_id: chatId, action: "typing" }, (message) => client.sendChatAction(message));
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

await Promise.all(bots.map((bot) => bot.run()));
