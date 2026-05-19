import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  buildModelKeyboard,
  buildModelsText,
  extractPromptText,
  extractThreadId,
  getCliWorkingDir,
  getBridgeProjectDir,
  handleCommand,
  isBridgeCommand,
  isAuthorizedMessage,
  parseCliResult,
  buildCliInvocation,
  buildExecutionOptions,
  validateBridgeConfig,
  runCli,
  runCliAsync,
  isCapacityExhaustedError,
  getNextFallbackModel,
  abortCliProcess,
  shutdownCliProcesses,
  toUserMessage,
  openDb,
  BridgeDb,
} from "./bridge.js";
import { TelegramClient, MediaGroupBuffer } from "./telegram.js";
import { sendTelegramMessage, sendMessageWithProgress } from "./messageDelivery.js";
import type { BridgeConfig, BotConfig, TelegramUpdate, TelegramMessage, TelegramCallbackQuery, CliResult } from "./types.js";

dotenv.config({
  path: process.env.BRIDGE_ENV_FILE || ".env",
  override: false,
});

function getServiceKindFromEnvFile(envPath: string): "codex" | "gemini" | "claude" | null {
  if (!envPath) return null;
  const name = basename(envPath);
  if (name.includes("codex")) return "codex";
  if (name.includes("gemini")) return "gemini";
  if (name.includes("claude")) return "claude";
  return null;
}

function parseModelPreference(raw: string | undefined): string[] {
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

const MAX_QUEUE_DEPTH = 5;
type QueuedMessage = { prompt: string; chatId: number; threadId?: number; chatKey: string; chatType: string; userId?: number };

const config: BridgeConfig = {
  allowedUserIds: new Set(
    (process.env.TELEGRAM_ALLOWED_USER_IDS || process.env.TELEGRAM_ALLOWED_USER_ID || "")
      .split(",").map(s => s.trim()).filter(Boolean)
  ),
  serviceEnvFile: process.env.BRIDGE_ENV_FILE || null,
  serviceKind: getServiceKindFromEnvFile(process.env.BRIDGE_ENV_FILE || ""),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 1000),
  executionMode: (process.env.BRIDGE_EXECUTION_MODE as "safe" | "trusted") || "safe",
  cliTimeoutMs: Number(process.env.CLI_TIMEOUT_MS || 300_000),
  cliIdleTimeoutMs: Number(process.env.CLI_IDLE_TIMEOUT_MS || 60_000),
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS || 45_000),
  asyncEnabled: process.env.BRIDGE_ASYNC_ENABLED !== "false",
  dbPath: process.env.DB_PATH || `${getBridgeProjectDir()}/.data/bridge.sqlite`,
  bots: {
    codex: {
      token: process.env.TELEGRAM_BOT_TOKEN_CODEX,
      command: process.env.CODEX_COMMAND || "codex",
      modelPreference: parseModelPreference(process.env.CODEX_MODEL_PREFERENCE),
    },
    gemini: {
      token: process.env.TELEGRAM_BOT_TOKEN_GEMINI,
      command: process.env.GEMINI_COMMAND || "gemini",
      modelPreference: parseModelPreference(process.env.GEMINI_MODEL_PREFERENCE),
    },
    claude: {
      token: process.env.TELEGRAM_BOT_TOKEN_CLAUDE,
      command: process.env.CLAUDE_COMMAND || "claude",
      modelPreference: parseModelPreference(process.env.CLAUDE_MODEL_PREFERENCE),
    },
  },
};

const validation = validateBridgeConfig(config);
if (!validation.ok) {
  throw new Error(`Invalid bridge config:\n- ${validation.errors.join("\n- ")}`);
}

const db = openDb(config.dbPath);

class BridgeBot {
  kind: "codex" | "gemini" | "claude";
  config: BotConfig;
  client: TelegramClient;
  mediaBuffer: MediaGroupBuffer;
  private abortedChats = new Set<string>();
  private pendingQueues = new Map<string, QueuedMessage[]>();

  constructor(kind: "codex" | "gemini" | "claude", botConfig: BotConfig) {
    this.kind = kind;
    this.config = botConfig;
    this.client = new TelegramClient(botConfig.token!, fetch, config.fetchTimeoutMs);
    this.mediaBuffer = new MediaGroupBuffer({
      timeoutMs: 1500,
      onFlush: (groupId, messages) => {
        this.handleMessages(messages).catch((err) => {
          console.error(`[${this.kind}] mediaBuffer flush error`, err);
        });
      },
    });
  }

  async run(): Promise<void> {
    await this.client.setMyCommands({
      commands: [
        { command: "models", description: "Switch model" },
        { command: "reset",  description: "Clear current session" },
        { command: "stop",   description: "Abort running execution" },
        { command: "memory", description: "Run memory smoke test" },
      ],
    }).catch((err) => console.warn(`[${this.kind}] setMyCommands failed`, err));

    let offset = db.getLastUpdateId(this.kind) + 1;
    console.log(`[${this.kind}] bot online (offset: ${offset})`);

    for (;;) {
      try {
        const updates = await this.client.getUpdates({
          offset,
          timeout: 30,
          allowed_updates: ["message", "callback_query"],
        });

        for (const update of (updates.result as any) ?? []) {
          const updateId: number = update.update_id;
          offset = updateId + 1;
          try {
            await this.handleUpdate(update);
          } catch (error) {
            console.error(`[${this.kind}] update handling failed`, error);
          }
          db.setLastUpdateId(this.kind, updateId);
        }

      } catch (error) {
        console.error(`[${this.kind}] polling failed`, error);
        await sleep(Math.max(config.pollIntervalMs, 5000));
      }
    }
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }

    const message = update.message;
    if (!message) return;
    if (!isAuthorizedMessage(message, config.allowedUserIds)) return;

    const rawText = (message.text || message.caption || "").trim().toLowerCase();
    if (rawText === "/stop" || rawText === "/cancel") {
      const chatId = message.chat.id;
      const chatKey = String(chatId);
      const threadId = message.message_thread_id;
      const wasAborted = abortCliProcess(chatKey);
      if (wasAborted) {
        db.unlock(chatKey);
        this.abortedChats.add(chatKey);
      }
      await sendTelegramMessage({
        client: this.client,
        kind: this.kind,
        chatId,
        body: { text: "🛑 Execution aborted by user.", message_thread_id: threadId },
      });
      return;
    }

    this.mediaBuffer.push(message);
  }

  async handleMessages(messages: TelegramMessage[]): Promise<void> {
    const primaryMessage = messages.find((m) => m.text || m.caption) || messages[0];

    const threadId = extractThreadId(messages);
    const rawText = (primaryMessage.text || primaryMessage.caption || "").trim();
    const commandText = isBridgeCommand(rawText) ? rawText : null;
    const prompt = commandText ? null : extractPromptText(primaryMessage);
    if (!commandText && !prompt) return;

    const chatId = primaryMessage.chat.id;
    const isGroup = primaryMessage.chat.type === "group" || primaryMessage.chat.type === "supergroup";
    const userId = primaryMessage.from?.id;
    const chatKey = isGroup
      ? `${chatId}:${threadId ?? ""}:${userId ?? ""}`
      : String(chatId);
    this.abortedChats.delete(chatKey);

    const commandResponse = commandText ? handleCommand(this.kind, commandText, {
      db,
      chatId: chatKey,
      config,
    }) : null;
    if (commandResponse) {
      if (commandResponse.kind === "message") {
        await this.sendText(chatId, { text: commandResponse.text, message_thread_id: threadId });
        return;
      }
      if (commandResponse.kind === "keyboard_message") {
        await this.sendText(chatId, {
          text: commandResponse.text,
          reply_markup: commandResponse.reply_markup,
          message_thread_id: threadId,
        });
        return;
      }
    }

    const sessionId = db.getSession(chatKey, this.kind);
    const effectiveSessionId = this.kind === "gemini" && !sessionId ? randomUUID() : sessionId;
    const useAsync = config.asyncEnabled === true;

    if (!db.tryLock(chatKey)) {
      const queue = this.pendingQueues.get(chatKey) ?? [];
      if (queue.length >= MAX_QUEUE_DEPTH) {
        await this.sendText(chatId, {
          text: `⏳ Queue is full (max ${MAX_QUEUE_DEPTH}). Please wait.`,
          message_thread_id: threadId,
        });
        return;
      }
      queue.push({ prompt: commandResponse?.kind === "execute" ? commandResponse.prompt : prompt!, chatId, threadId, chatKey, chatType: primaryMessage.chat.type, userId });
      this.pendingQueues.set(chatKey, queue);
      await this.sendText(chatId, {
        text: `⏳ Queued (position ${queue.length} of ${MAX_QUEUE_DEPTH}). Will process shortly.`,
        message_thread_id: threadId,
      });
      return;
    }

    try {
      if (useAsync) {
        await sendMessageWithProgress({
          client: this.client,
          kind: this.kind,
          chatId,
          body: { message_thread_id: threadId },
          isAborted: () => this.abortedChats.has(chatKey),
          execution: (onProgress: (text: string) => void) =>
            this.executePromptAsync(commandResponse?.kind === "execute" ? commandResponse.prompt : prompt!, effectiveSessionId, chatId, { message_thread_id: threadId }, onProgress),
        });
      } else {
        const result = await this.executePrompt(commandResponse?.kind === "execute" ? commandResponse.prompt : prompt!, effectiveSessionId, chatId, { message_thread_id: threadId });
        await this.sendText(chatId, { text: result.text, message_thread_id: threadId });
      }
    } catch (error) {
      console.error(`[${this.kind}] prompt execution failed`, error);
      const userText = toUserMessage(error instanceof Error ? error : new Error(String(error)));
      await sendTelegramMessage({
        client: this.client,
        kind: this.kind,
        chatId,
        body: { text: `Error: ${userText}`, message_thread_id: threadId },
      });
    } finally {
      db.unlock(chatKey);
      this.drainQueue(chatKey);
    }
  }

  private drainQueue(chatKey: string): void {
    const queue = this.pendingQueues.get(chatKey);
    if (!queue?.length) return;
    const next = queue.shift()!;
    if (!queue.length) this.pendingQueues.delete(chatKey);
    setImmediate(() => {
      this.sendText(next.chatId, {
        text: "▶️ Processing your queued message...",
        message_thread_id: next.threadId,
      }).catch(() => {});
      const syntheticMessage: TelegramMessage = {
        message_id: 0,
        chat: { id: next.chatId, type: next.chatType },
        from: { id: next.userId ?? Number([...config.allowedUserIds][0] ?? 0), first_name: "queue" },
        message_thread_id: next.threadId,
        text: next.prompt,
      };
      this.handleMessages([syntheticMessage]).catch((err) =>
        console.error(`[${this.kind}] drainQueue error`, err)
      );
    });
  }

  async executePromptAsync(prompt: string, sessionId: string | null, chatId: number, body: any = {}, onProgress = (_text: string) => {}): Promise<CliResult> {
    const { message_thread_id: threadId } = body;
    const chatKey = String(chatId);
    const model = db.getSetting(this.kind) || this.config.modelPreference[0] || null;
    const invocation = buildCliInvocation({
      bot: this.kind,
      command: this.config.command,
      model,
      prompt,
      sessionId,
      sessionMode: this.kind === "gemini" && !db.getSession(chatKey, this.kind) ? "session-id" : "resume",
      executionMode: config.executionMode,
      outputFormat: "json",
    });
    try {
      const cliResult = await runCliAsync(invocation.command, invocation.args, getCliWorkingDir(this.kind), {
        ...buildExecutionOptions(config),
        onProgress,
        chatId: chatKey,
      });

      const result = parseCliResult({ bot: this.kind, stdout: cliResult.text });
      if (result?.sessionId) db.setSession(chatKey, this.kind, result.sessionId);
      return result;
    } catch (error) {
      if (isCapacityExhaustedError(error as Error) && this.config.modelPreference.length > 1) {
        const fallbackModel = getNextFallbackModel(model, this.config.modelPreference);
        if (fallbackModel) {
          const fallbackInvocation = buildCliInvocation({
            bot: this.kind,
            command: this.config.command,
            model: fallbackModel,
            prompt,
            sessionId,
            sessionMode: "resume",
            executionMode: config.executionMode,
            outputFormat: "json",
          });
          const cliResult = await runCliAsync(fallbackInvocation.command, fallbackInvocation.args, getCliWorkingDir(this.kind), {
            ...buildExecutionOptions(config),
            onProgress,
            chatId: chatKey,
          });
          const result = parseCliResult({ bot: this.kind, stdout: cliResult.text });
          if (result?.sessionId) db.setSession(chatKey, this.kind, result.sessionId);
          return {
            ...result,
            text: `⚠️ Fell back to ${fallbackModel} (${model || "default"} at capacity)\n\n${result.text}`,
          };
        }
      }
      throw error;
    }
  }

  async executePrompt(prompt: string, sessionId: string | null, chatId: number, body: any = {}): Promise<CliResult> {
    const { message_thread_id: threadId } = body;
    const chatKey = String(chatId);
    const model = db.getSetting(this.kind) || this.config.modelPreference[0] || null;
    const invocation = buildCliInvocation({
      bot: this.kind,
      command: this.config.command,
      model,
      prompt,
      sessionId,
      sessionMode: this.kind === "gemini" && !db.getSession(chatKey, this.kind) ? "session-id" : "resume",
      executionMode: config.executionMode,
    });
    const typingTracker = createTypingTracker(this.client, chatId, this.kind, { message_thread_id: threadId });

    try {
      await typingTracker.start();
      const stdout = await runCli(invocation.command, invocation.args, getCliWorkingDir(this.kind), {
        ...buildExecutionOptions(config),
        chatId: chatKey,
      });
      const result = parseCliResult({ bot: this.kind, stdout });
      if (result.sessionId) db.setSession(chatKey, this.kind, result.sessionId);
      return result;
    } catch (error) {
      if (isCapacityExhaustedError(error as Error) && this.config.modelPreference.length > 1) {
        const fallbackModel = getNextFallbackModel(model, this.config.modelPreference);
        if (fallbackModel) {
          const fallbackInvocation = buildCliInvocation({
            bot: this.kind,
            command: this.config.command,
            model: fallbackModel,
            prompt,
            sessionId,
            sessionMode: "resume",
            executionMode: config.executionMode,
          });
          const stdout = await runCli(fallbackInvocation.command, fallbackInvocation.args, getCliWorkingDir(this.kind), {
            ...buildExecutionOptions(config),
            chatId: chatKey,
          });
          const result = parseCliResult({ bot: this.kind, stdout });
          if (result.sessionId) db.setSession(chatKey, this.kind, result.sessionId);
          return {
            ...result,
            text: `⚠️ Fell back to ${fallbackModel} (${model || "default"} at capacity)\n\n${result.text}`,
          };
        }
      }
      throw error;
    } finally {
      await typingTracker.stop();
    }
  }

  async handleCallback(callbackQuery: TelegramCallbackQuery): Promise<void> {
    const fromId = callbackQuery?.from?.id;
    if (!config.allowedUserIds.has(String(fromId))) return;

    const data = String(callbackQuery?.data || "");
    const [action, targetKind, ...rest] = data.split(":");
    if (action !== "model" || targetKind !== this.kind) return;

    const value = rest.join(":").trim();
    const messageId = callbackQuery.message?.message_id;
    const chatId = callbackQuery.message?.chat?.id;
    if (!chatId || !messageId) return;

    if (value === "reset") {
      db.setSetting(this.kind, null);
      await this.client.answerCallbackQuery({
        callback_query_id: callbackQuery.id,
        text: `${this.kind} reset to default`,
      });
      await this.client.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: buildModelsText(this.kind, { db, config }),
        reply_markup: buildModelKeyboard(this.kind, this.config.modelPreference, null),
      });
      return;
    }

    db.setSetting(this.kind, value);
    await this.client.answerCallbackQuery({ callback_query_id: callbackQuery.id });
    await this.client.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text: buildModelsText(this.kind, { db, config }),
      reply_markup: buildModelKeyboard(this.kind, this.config.modelPreference, value),
    });
    await this.sendText(chatId, { text: `✓ Model set to ${value}` });
  }

  async sendText(chatId: number, body: any): Promise<void> {
    await sendTelegramMessage({ client: this.client, kind: this.kind, chatId, body });
  }
}

function createTypingTracker(client: TelegramClient, chatId: number, kind: string, body: any = {}) {
  let timer: NodeJS.Timeout | null = null;
  let active = false;
  const { message_thread_id: threadId } = body;

  const sendTyping = async () => {
    if (!active) return;
    try {
      await client.sendChatAction({ chat_id: chatId, message_thread_id: threadId, action: "typing" });
    } catch (error: any) {
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
    },
    async stop() {
      active = false;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log("[bridge] starting bots...");

const bots = (Object.entries(config.bots) as [("codex" | "gemini" | "claude"), BotConfig][])
  .filter(([, bot]) => bot.token)
  .map(([kind, botConfig]) => new BridgeBot(kind, botConfig));

const shutdown = (signal: string) => {
  console.log(`[bridge] ${signal} received, shutting down...`);
  shutdownCliProcesses();
  db.close();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await Promise.all(bots.map((bot) => bot.run()));
