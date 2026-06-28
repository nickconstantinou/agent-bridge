/**
 * PURPOSE: Reusable BridgeEngine — polling loop, concurrency locking, message queuing,
 *   and CLI execution dispatcher. Extracted from BridgeBot (index.ts) so both the agent
 *   bots and the health bot can share one robust implementation.
 * INPUTS: Engine options (kind, botConfig, allowedUserIds, hooks), BridgeDb, TelegramClient.
 * OUTPUTS: Telegram replies, CLI dispatches, session/lock state updates.
 * NEIGHBORS: src/index.ts, src/index-health.ts, src/cli.ts, src/db.ts, src/telegram.ts
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, rmSync, unlinkSync } from "node:fs";
import {
  buildCliInvocation,
  buildExecutionOptions,
  runCli as _runCli,
  runCliAsync as _runCliAsync,
  parseCliResult,
  isCapacityExhaustedError,
  getNextFallbackModel,
  abortCliProcess,
  toUserMessage,
  resolveAntigravityConversationId,
  setAntigravityModel,
  scrubOutputDir,
} from "./cli.js";
import { MediaGroupBuffer } from "./telegram.js";
import type { MessagingPlatform } from "./platform.js";
import { downloadTelegramAttachment } from "./fileDownload.js";
import { prepareOutputDir, uploadOutputFiles } from "./fileOutput.js";
import { parseClaudeStreamJsonOutput } from "./claudeStreamJson.js";
import { createPollErrorState, planPollError, notePollSuccess } from "./polling.js";
import { sendTelegramMessage, sendMessageWithProgress } from "./messageDelivery.js";
import { buildModelKeyboard, buildModelsText, getCliWorkingDir, extractPromptText, extractThreadId, isAuthorizedMessage } from "./bridge.js";
import { handleCommand, isBridgeCommand, buildTelegramCommands, isAntigravityNarrationVisible, compactInProgressSettingKey } from "./commands.js";
import { buildEffortKeyboard, buildEffortText, effortSettingKey, resolveDefaultEffort, resolveEffort, isEffortLevel } from "./effort.js";
import { getCodexUsageText } from "./codexUsage.js";
import { buildCompactReducePrompt, buildCompactSummaryPrompt, buildTombstone, chunkCompactTurns, compactParallelism, COMPACT_TIMEOUT_MS } from "./compactSummary.js";
import type { BridgeEvent } from "./events/types.js";
import { EventStore } from "./events/store.js";
import type { BridgeConfig, BotKind, BotConfig, TelegramUpdate, TelegramMessage, TelegramCallbackQuery, CliResult, CliOptions } from "./types.js";
import type { BridgeDb } from "./db.js";
import { DEFAULT_CONTEXT_MAX_CHARS } from "./db.js";
import { resolveTimeoutsForKind } from "./timeouts.js";
import { extractProjectMemorySidecars, storeProjectMemoryCandidate } from "./projectMemory.js";
import { buildPostTurnMemoryExtractionPrompt, parsePostTurnMemoryCandidates } from "./memoryExtractor.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface HookContext {
  chatId: number;
  chatKey: string;
  threadId?: number;
  userId?: number;
}

export interface HookCommandResult {
  text: string;
  reply_markup?: any;
}

export interface BridgeEngineHooks {
  /** Called before the built-in command handler. Return non-null to handle the command. */
  onCommand?: (cmd: string, ctx: HookContext) => Promise<HookCommandResult | null>;
  /** Called before CLI execution. Return the (optionally transformed) prompt. */
  onBeforeExecute?: (prompt: string, ctx: HookContext) => Promise<string>;
  /** Called when the CLI throws a capacity/rate-limit error after all model fallbacks are exhausted. */
  onCapacityExhausted?: (chatKey: string) => void | Promise<void>;
  /** Called after a successful CLI execution. */
  onAfterExecute?: (prompt: string, resultText: string, ctx: HookContext) => void | Promise<void>;
}

export interface BridgeEngineOptions {
  kind: string;
  /** CLI kind to invoke for non-agent engines such as health. Defaults to claude. */
  executionKind?: BotKind;
  botConfig: { command: string; modelPreference: string[]; token?: string };
  allowedUserIds: ReadonlySet<string>;
  executionMode: "safe" | "trusted";
  asyncEnabled: boolean;
  pollIntervalMs: number;
  soulContext?: string | null;
  /** Required for built-in /models command on agent bot kinds */
  fullConfig?: BridgeConfig;
  hooks?: BridgeEngineHooks;
}

/** Injected execution functions — replace real CLI for unit tests. */
export interface ExecFns {
  runCli: typeof _runCli;
  runCliAsync: typeof _runCliAsync;
}

// ── Internals ────────────────────────────────────────────────────────────────

const MAX_QUEUE_DEPTH = 5;
const ENGINE_CONTEXT_MAX_CHARS = parseInt(process.env.BRIDGE_CONTEXT_MAX_CHARS ?? "") || DEFAULT_CONTEXT_MAX_CHARS;
const ENGINE_TURN_TEXT_LIMIT = 1_200;

const AGENT_KINDS = new Set<string>(["codex", "antigravity", "claude"]);
function isAgentKind(kind: string): kind is BotKind {
  return AGENT_KINDS.has(kind);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
}

function isAntigravityPrintTimeoutError(error: Error): boolean {
  return /agy execution timed out waiting for response|print mode timed out waiting for response/i.test(error.message ?? "");
}

function isRecoverableAntigravityExecutionError(error: Error): boolean {
  const message = error.message ?? "";
  return /error executing cascade step:|agent executor error:|PlannerResponse without ModifiedResponse|Agy stalled in planner loop without usable output|Agy JSON parse failed/i.test(message);
}

function topicChatKey(chatId: number, chatType: string, threadId?: number): string {
  const isGroup = chatType === "group" || chatType === "supergroup";
  return isGroup && threadId != null ? `${chatId}:${threadId}` : String(chatId);
}

function hookContext(chatId: number, chatKey: string, threadId?: number | string): HookContext {
  const numericThreadId = typeof threadId === "string" ? Number(threadId) : threadId;
  return {
    chatId,
    chatKey,
    threadId: Number.isFinite(numericThreadId) ? numericThreadId : undefined,
  };
}

function trimTurnText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= ENGINE_TURN_TEXT_LIMIT) return normalized;
  return `${normalized.slice(0, ENGINE_TURN_TEXT_LIMIT - 15).trimEnd()}... [truncated]`;
}

function isPostTurnMemoryExtractorEnabled(): boolean {
  return process.env.BRIDGE_MEMORY_EXTRACTOR_ENABLED === "1";
}

function createTypingTracker(client: MessagingPlatform, chatId: number, kind: string, body: any = {}) {
  let timer: NodeJS.Timeout | null = null;
  let active = false;
  const { message_thread_id: threadId } = body;

  const sendTyping = async () => {
    if (!active) return;
    try {
      await client.sendChatAction({ chat_id: chatId, message_thread_id: threadId, action: "typing" });
    } catch (error: any) {
      // typing indicator failure is non-fatal
    }
  };

  return {
    async start() {
      if (active) return;
      active = true;
      await sendTyping();
      timer = setInterval(() => { void sendTyping(); }, 4500);
    },
    async stop() {
      active = false;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

// ── BridgeEngine ──────────────────────────────────────────────────────────────

export class BridgeEngine {
  readonly kind: string;
  readonly client: MessagingPlatform;
  readonly mediaBuffer: MediaGroupBuffer;

  private readonly opts: BridgeEngineOptions;
  private readonly db: BridgeDb;
  private readonly hooks: BridgeEngineHooks;
  private readonly exec: ExecFns;
  private readonly abortedChats = new Set<string>();

  constructor(
    opts: BridgeEngineOptions,
    db: BridgeDb,
    client: MessagingPlatform,
    exec: Partial<ExecFns> = {},
  ) {
    this.opts = opts;
    this.kind = opts.kind;
    this.db = db;
    this.client = client;
    this.hooks = opts.hooks ?? {};
    this.exec = {
      runCli: exec.runCli ?? _runCli,
      runCliAsync: exec.runCliAsync ?? _runCliAsync,
    };
    this.mediaBuffer = new MediaGroupBuffer({
      timeoutMs: 1500,
      onFlush: (_groupId, messages) => {
        return this.handleMessages(messages).catch((err) => {
          console.error(`[${this.kind}] mediaBuffer flush error`, err);
        });
      },
    });
  }

  async run(): Promise<void> {
    if (isAgentKind(this.kind)) {
      await this.client.setMyCommands({
        commands: buildTelegramCommands(this.kind),
      }).catch((err) => console.warn(`[${this.kind}] setMyCommands failed`, err));
    }

    let offset = isAgentKind(this.kind) ? this.db.getLastUpdateId(this.kind) + 1 : 0;
    console.log(`[${this.kind}] engine online (offset: ${offset})`);

    const pollErrState = createPollErrorState();
    const defaultErrorSleepMs = Math.max(this.opts.pollIntervalMs, 5000);

    for (;;) {
      try {
        const updates = await this.client.getUpdates({
          offset,
          timeout: 30,
          allowed_updates: ["message", "callback_query"],
        });

        if (notePollSuccess(pollErrState)) {
          console.log(`[${this.kind}] polling recovered`);
        }

        for (const update of (updates.result as any) ?? []) {
          const updateId: number = update.update_id;
          offset = updateId + 1;
          if (isAgentKind(this.kind)) {
            this.db.setLastUpdateId(this.kind, updateId);
          }
          this.handleUpdate(update).catch((error) => {
            console.error(`[${this.kind}] update handling failed`, error);
          });
        }
      } catch (error) {
        const plan = planPollError(error, pollErrState, defaultErrorSleepMs);
        if (plan.logKind === "warn-once") {
          console.warn(`[${this.kind}] ${plan.message}`);
        } else if (plan.logKind === "error-stack") {
          console.error(`[${this.kind}] ${plan.message}`, error);
        }
        await new Promise((r) => setTimeout(r, plan.sleepMs));
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
    if (!isAuthorizedMessage(message, this.opts.allowedUserIds)) return;

    const rawText = (message.text || message.caption || "").trim().toLowerCase();
    if (rawText === "/stop" || rawText === "/cancel") {
      const chatId = message.chat.id;
      const threadId = message.message_thread_id;
      const chatKey = topicChatKey(chatId, message.chat.type, threadId);
      const wasAborted = abortCliProcess(chatKey);
      if (wasAborted) {
        this.db.unlock(chatKey);
        this.abortedChats.add(chatKey);
      }
      const pendingStop = this.db.dequeueMsgs(chatKey);
      for (const m of pendingStop) this.db.deletePendingMsg(m.id);
      await this.sendText(chatId, { text: "🛑 Execution aborted by user.", message_thread_id: threadId });
      return;
    }

    await this.mediaBuffer.push(message);
  }

  async handleMessages(messages: TelegramMessage[]): Promise<void> {
    const primaryMessage = messages.find((m) => m.text || m.caption) || messages[0];

    // Auth check — defence-in-depth; handleUpdate also checks before buffering
    if (!isAuthorizedMessage(primaryMessage, this.opts.allowedUserIds)) return;

    const threadId = extractThreadId(messages);
    const rawText = (primaryMessage.text || primaryMessage.caption || "").trim();
    // A slash command is any text starting with /; isBridgeCommand only covers built-ins
    const isSlashCmd = rawText.startsWith("/");
    const commandText = isSlashCmd ? rawText : null;
    const hasAttachment = !!(primaryMessage.photo?.length || primaryMessage.document);
    const rawPrompt = commandText ? null : extractPromptText(primaryMessage);
    const prompt = commandText ? null : (rawPrompt || (hasAttachment ? "Describe the attached file." : null));
    if (!commandText && !prompt) return;

    const chatId = primaryMessage.chat.id;
    const userId = primaryMessage.from?.id;
    const chatKey = topicChatKey(chatId, primaryMessage.chat.type, threadId);
    this.abortedChats.delete(chatKey);

    const hookCtx: HookContext = { chatId, chatKey, threadId, userId };

    // ── Command handling ──────────────────────────────────────────────────────
    if (commandText) {
      // Plugin hook first
      if (this.hooks.onCommand) {
        const hookResult = await this.hooks.onCommand(commandText, hookCtx);
        if (hookResult !== null) {
          if (hookResult.text) {
            await this.sendText(chatId, {
              text: hookResult.text,
              reply_markup: hookResult.reply_markup,
              message_thread_id: threadId,
            });
          }
          return;
        }
      }

      // Built-in handler for known agent kinds
      if (isAgentKind(this.kind) && isBridgeCommand(commandText)) {
        const commandResponse = handleCommand(this.kind, commandText, {
          db: this.db,
          chatId: chatKey,
          config: this._effectiveConfig(),
        });
        if (commandResponse) {
          if (commandResponse.kind === "message") {
            if (commandText === "/reset") {
              const pending = this.db.dequeueMsgs(chatKey);
              for (const m of pending) this.db.deletePendingMsg(m.id);
              this.db.setSetting(`ctx_suppress:${chatKey}`, "1");
              abortCliProcess(chatKey);
              this.db.unlock(chatKey);
            }
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
          if (commandResponse.kind === "codex_usage") {
            try {
              const text = await getCodexUsageText();
              await this.sendText(chatId, { text, message_thread_id: threadId });
            } catch (error) {
              const userText = toUserMessage(error instanceof Error ? error : new Error(String(error)));
              await this.sendText(chatId, { text: `Error: ${userText}`, message_thread_id: threadId });
            }
            return;
          }
          if (commandResponse.kind === "execute") {
            // Fall through to execution with the overridden prompt
            return this._executeAndSend(commandResponse.prompt, chatId, chatKey, primaryMessage.chat.type, threadId, userId, hookCtx, []);
          }
          if (commandResponse.kind === "compact") {
            const ck = commandResponse.chatKey;
            const inProgressKey = compactInProgressSettingKey(ck);
            const activeSince = this.db.getSetting(inProgressKey);
            if (activeSince) {
              await this.sendText(chatId, {
                text: `Compact already in progress since ${activeSince}. Run /context to check status.`,
                message_thread_id: threadId,
              });
              return;
            }
            const previousSummary = this.db.getLatestConvSummary(ck);
            const turns = this.db.getConvTurnsForCompaction(ck);
            if (turns.length === 0) {
              await this.sendText(chatId, { text: "Nothing to compact — no conversation turns yet.", message_thread_id: threadId });
              return;
            }
            const startId = turns[0].id;
            const endId = turns[turns.length - 1].id;
            const chunks = chunkCompactTurns(turns);
            const startedAt = new Date().toISOString();
            await this.sendText(chatId, {
              text: `Compacting context... ${turns.length} turn${turns.length === 1 ? "" : "s"} across ${chunks.length} chunk${chunks.length === 1 ? "" : "s"}. /context will show progress.`,
              message_thread_id: threadId,
            });
            this.db.setSetting(inProgressKey, startedAt);
            console.log(`[compact] start chatKey=${ck} bot=${this.kind} turns=${turns.length} chunks=${chunks.length} startId=${startId} endId=${endId}`);

            let summaryMd: string;
            const summarizePrompt = async (summaryPrompt: string): Promise<string> => {
              const model = this.db.getSetting(this.kind) || this.opts.botConfig.modelPreference[0] || null;
              const invocation = buildCliInvocation({
                bot: this.kind,
                prompt: summaryPrompt,
                sessionId: null,
                command: this.opts.botConfig.command,
                model,
                effort: resolveEffort(this.kind as BotKind, this.db),
                executionMode: "safe",
              });
              const raw = await Promise.race([
                this.exec.runCli(invocation.command, invocation.args, process.cwd(), {}),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error("compact timeout")), COMPACT_TIMEOUT_MS)
                ),
              ]);
              if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
              throw new Error("empty compact summary");
            };
            try {
              if (chunks.length === 1 && !previousSummary) {
                summaryMd = await summarizePrompt(buildCompactSummaryPrompt(turns));
              } else {
                const parallelism = compactParallelism();
                console.log(`[compact] summarizing chatKey=${ck} chunks=${chunks.length} parallelism=${parallelism}`);
                const chunkSummaries = await mapWithConcurrency(chunks, parallelism, async (chunk) => {
                  return {
                    startId: chunk[0].id!,
                    endId: chunk[chunk.length - 1].id!,
                    summary: await summarizePrompt(buildCompactSummaryPrompt(chunk)),
                  };
                });
                summaryMd = await summarizePrompt(buildCompactReducePrompt(previousSummary?.summary_md ?? null, chunkSummaries));
              }
            } catch {
              console.warn(`[compact] summarization fallback chatKey=${ck} bot=${this.kind} turns=${turns.length}`);
              summaryMd = buildTombstone(turns, this.kind);
            }

            try {
              this.db.addConvSummary(ck, startId, endId, summaryMd);
              this.db.pruneConvTurns(ck, endId);
              this.db.setSetting(`ctx_suppress:${ck}`, null);
              if (isAgentKind(this.kind)) db_setSession(this.db, ck, this.kind, null);
              console.log(`[compact] success chatKey=${ck} summaryRange=${startId}-${endId} chars=${summaryMd.length}`);
              await this.sendText(chatId, {
                text: `Context compacted. ${turns.length} turn${turns.length === 1 ? "" : "s"} summarised. Session reset — next message starts fresh, seeded with this summary.`,
                message_thread_id: threadId,
              });
            } finally {
              this.db.setSetting(inProgressKey, null);
            }
            return;
          }
        }
        return; // Unrecognised command for agent bot — ignore
      }

      // For non-agent kinds with no hook match — ignore
      return;
    }

    // ── Prompt execution ──────────────────────────────────────────────────────
    const uploadDir = join(tmpdir(), `bridge-uploads-${chatId}`);
    let attachmentLocalPath: string | null = null;
    if (hasAttachment) {
      try {
        const info = await downloadTelegramAttachment(this.client, primaryMessage, uploadDir);
        attachmentLocalPath = info?.localPath ?? null;
      } catch (err) {
        console.error(`[${this.kind}] attachment download failed`, err);
      }
    }
    const attachments: string[] = attachmentLocalPath ? [attachmentLocalPath] : [];

    return this._executeAndSend(prompt!, chatId, chatKey, primaryMessage.chat.type, threadId, userId, hookCtx, attachments, attachmentLocalPath);
  }

  private async _executeAndSend(
    rawPrompt: string,
    chatId: number,
    chatKey: string,
    chatType: string,
    threadId: number | undefined,
    userId: number | undefined,
    hookCtx: HookContext,
    attachments: string[],
    attachmentLocalPath: string | null = null,
  ): Promise<void> {
    // Apply onBeforeExecute hook
    let prompt = rawPrompt;
    if (this.hooks.onBeforeExecute) {
      prompt = await this.hooks.onBeforeExecute(rawPrompt, hookCtx);
    }

    const sessionId = isAgentKind(this.kind)
      ? this.db.getSession(chatKey, this.kind)
      : null;
    const useAsync = this.opts.asyncEnabled === true;

    if (!this.db.tryLock(chatKey)) {
      if (this.db.pendingMsgCount(chatKey) >= MAX_QUEUE_DEPTH) {
        if (attachmentLocalPath) { try { unlinkSync(attachmentLocalPath); } catch {} }
        await this.sendText(chatId, {
          text: `⏳ Queue is full (max ${MAX_QUEUE_DEPTH}). Please wait.`,
          message_thread_id: threadId,
        });
        return;
      }
      this.db.enqueueMsg(chatKey, { prompt, chatId, threadId, chatType, userId });
      const queuePos = this.db.pendingMsgCount(chatKey);
      if (attachmentLocalPath) { try { unlinkSync(attachmentLocalPath); } catch {} }
      await this.sendText(chatId, {
        text: `⏳ Queued (position ${queuePos} of ${MAX_QUEUE_DEPTH}). Will process shortly.`,
        message_thread_id: threadId,
      });
      return;
    }

    try {
      if (useAsync) {
        const { runId, eventContext, collect, finalize } = this._createEventContext(chatId, threadId);
        await sendMessageWithProgress({
          client: this.client,
          kind: this._deliveryKind(),
          chatId,
          body: { message_thread_id: threadId },
          showProgressNarration: this.kind === "antigravity" && isAntigravityNarrationVisible(this.db, chatKey),
          isAborted: () => this.abortedChats.has(chatKey),
          runId,
          onEvent: (e) => collect(e),
          execution: (onProgress: (text: string) => void) =>
            this.executePromptAsync(prompt, sessionId, chatId, { message_thread_id: threadId }, onProgress, attachments, eventContext, runId, collect, chatKey),
        });
        finalize();
      } else {
        const { runId, eventContext, collect, finalize } = this._createEventContext(chatId, threadId);
        const result = await this.executePrompt(prompt, sessionId, chatId, { message_thread_id: threadId }, attachments, eventContext, runId, collect, chatKey);
        finalize();
        // For the sync path the final message is sent below; build a view from the
        // collected events so the new event-driven path drives the output text.
        if (result && result.text) {
          await this.sendText(chatId, { text: result.text, message_thread_id: threadId });
        }
      }
    } catch (error) {
      console.error(`[${this.kind}] prompt execution failed`, error);
      if (isCapacityExhaustedError(error instanceof Error ? error : new Error(String(error))) && this.hooks.onCapacityExhausted) {
        await this.hooks.onCapacityExhausted(chatKey);
      } else {
        let userText = toUserMessage(error instanceof Error ? error : new Error(String(error)));
        if (isCapacityExhaustedError(error instanceof Error ? error : new Error(String(error)))) {
          userText += `\n\n💡 All models for ${this.kind} are currently exhausted. Please try again later.`;
        }
        await sendTelegramMessage({
          client: this.client,
          kind: this._deliveryKind(),
          chatId,
          body: { text: `Error: ${userText}`, message_thread_id: threadId },
        });
      }
    } finally {
      if (attachmentLocalPath) { try { unlinkSync(attachmentLocalPath); } catch {} }
      this.db.unlock(chatKey);
      this._drainQueue(chatKey);
    }
  }

  /**
   * Build a fresh event context for a single run. Returns the runId, the
   * eventContext payload expected by `runCli`/`runCliAsync`, and a collector
   * that downstream consumers (sendMessageWithProgress) can use to receive
   * every emitted event for the run. The collector writes into a shared
   * array on the returned record so callers can also read the buffered
   * events if they need to inspect them.
   */
  private _createEventContext(chatId: number, threadId?: number): {
    runId: string;
    eventContext: CliOptions["eventContext"];
    collect: (e: BridgeEvent) => void;
    finalize: () => void;
    events: BridgeEvent[];
  } {
    const runId = randomUUID();
    const eventContext = {
      runId,
      bot: (isAgentKind(this.kind) ? this.kind : "claude") as BotKind,
      chatId: String(chatId),
      threadId: threadId != null ? String(threadId) : undefined,
    };
    const events: BridgeEvent[] = [];
    const store = new EventStore(this.db);

    const collect = (e: BridgeEvent) => {
      events.push(e);
      if (e.type === "run.completed") {
        store.queueCompleted(e);
      } else {
        store.collect(e);
      }
    };
    const finalize = () => store.finalize();
    return { runId, eventContext, collect, finalize, events };
  }

  private _drainQueue(chatKey: string): void {
    const msgs = this.db.dequeueMsgs(chatKey);
    if (!msgs.length) return;
    const next = msgs[0];
    this.db.deletePendingMsg(next.id);
    setImmediate(() => {
      this.sendText(next.chatId, {
        text: "▶️ Processing your queued message...",
        message_thread_id: next.threadId ?? undefined,
      }).catch(() => {});
      const syntheticMessage: TelegramMessage = {
        message_id: 0,
        chat: { id: next.chatId, type: next.chatType },
        from: { id: next.userId ?? Number([...this.opts.allowedUserIds][0] ?? 0), first_name: "queue" },
        message_thread_id: next.threadId ?? undefined,
        text: next.prompt,
      };
      this.handleMessages([syntheticMessage]).catch((err) =>
        console.error(`[${this.kind}] drainQueue error`, err)
      );
    });
  }

  private _rememberTurn(chatKey: string, userPrompt: string, assistantText: string): void {
    this.db.addConvTurn(chatKey, "user", trimTurnText(userPrompt), this.kind);
    this.db.addConvTurn(chatKey, "assistant", trimTurnText(assistantText), this.kind);
  }

  private _applyMemorySidecars(chatKey: string, resultText: string): string {
    const extracted = extractProjectMemorySidecars(resultText);
    for (const candidate of extracted.candidates) {
      storeProjectMemoryCandidate(this.db.raw, candidate, {
        chatKey,
        cliKind: this.kind,
        repoPath: process.cwd(),
      });
    }
    return extracted.cleanText;
  }

  private async _extractPostTurnMemories(
    chatKey: string,
    userPrompt: string,
    assistantText: string,
    mode: "async" | "sync",
  ): Promise<void> {
    if (!isAgentKind(this.kind) || !isPostTurnMemoryExtractorEnabled()) return;
    const executionKind = this._executionKind();
    const model = isAgentKind(this.kind)
      ? (this.db.getSetting(this.kind) || this.opts.botConfig.modelPreference[0] || null)
      : (this.opts.botConfig.modelPreference[0] || null);
    const cwd = getCliWorkingDir(executionKind);
    const prompt = buildPostTurnMemoryExtractionPrompt({ userPrompt, assistantText });
    const invocation = buildCliInvocation({
      bot: executionKind,
      command: this.opts.botConfig.command,
      model,
      effort: resolveEffort(executionKind, this.db),
      prompt,
      sessionId: null,
      executionMode: this.opts.executionMode,
      outputFormat: executionKind === "antigravity" ? undefined : "json",
      soulContext: this.opts.soulContext,
    });

    try {
      const raw = mode === "async"
        ? (await this.exec.runCliAsync(invocation.command, invocation.args, cwd, {
            ...buildExecutionOptions(executionKind),
            stdin: invocation.stdin,
            chatId: chatKey,
          })).text
        : await this.exec.runCli(invocation.command, invocation.args, cwd, {
            ...buildExecutionOptions(executionKind),
            stdin: invocation.stdin,
            chatId: chatKey,
          });
      const parsed = parseCliResult({ bot: executionKind, stdout: raw });
      for (const candidate of parsePostTurnMemoryCandidates(parsed.text || raw)) {
        storeProjectMemoryCandidate(this.db.raw, candidate, {
          chatKey,
          cliKind: this.kind,
          repoPath: process.cwd(),
        });
      }
    } catch (error) {
      console.warn(`[${this.kind}] post-turn memory extraction failed`, error);
    }
  }

  private _buildRecentContextPrompt(chatKey: string, prompt: string): string {
    if (this.db.getSetting(`ctx_suppress:${chatKey}`)) return prompt;
    const ctx = this.db.buildConvContext(chatKey, ENGINE_CONTEXT_MAX_CHARS);
    return ctx ? `${ctx}${prompt}` : prompt;
  }

  private _buildContextAccess(chatKey: string): { prompt: string; env: Record<string, string> } | null {
    const dbPath = this.opts.fullConfig?.dbPath;
    if (!dbPath) return null;
    const status = this.db.getConvStatus(chatKey);
    if (status.turnCount === 0 && !status.latestSummaryAt) return null;
    const commandPath = join(process.cwd(), "bin", "agent-bridge-context");
    const memoryHint = this.db.getMemoryCount() > 0 ? [
      '"$AGENT_BRIDGE_CONTEXT_COMMAND" --memory',
      '"$AGENT_BRIDGE_CONTEXT_COMMAND" --memory-query "<specific query>"',
      '"$AGENT_BRIDGE_CONTEXT_COMMAND" --memory-add-json \'<json>\'',
    ] : [];
    return {
      prompt: [
        "[Agent Bridge context]",
        "More conversation history is available if needed:",
        '"$AGENT_BRIDGE_CONTEXT_COMMAND" --summary',
        '"$AGENT_BRIDGE_CONTEXT_COMMAND" --recent 20',
        ...memoryHint,
        "",
      ].join("\n"),
      env: {
        AGENT_BRIDGE_CONTEXT_AVAILABLE: "1",
        AGENT_BRIDGE_CONTEXT_COMMAND: commandPath,
        AGENT_BRIDGE_CONTEXT_DB: dbPath,
        AGENT_BRIDGE_CHAT_KEY: chatKey,
        AGENT_BRIDGE_CLI_KIND: this.kind,
        AGENT_BRIDGE_REPO_PATH: process.cwd(),
      },
    };
  }

  private _buildPromptForCli(chatKey: string, prompt: string): { prompt: string; contextEnv?: Record<string, string> } {
    const contextPrompt = this._buildRecentContextPrompt(chatKey, prompt);
    const access = this._buildContextAccess(chatKey);
    if (!access) return { prompt: contextPrompt };
    return {
      prompt: `${access.prompt}${contextPrompt}`,
      contextEnv: access.env,
    };
  }

  async executePromptAsync(
    prompt: string,
    sessionId: string | null,
    chatId: number,
    body: any = {},
    onProgress = (_text: string) => {},
    attachments: string[] = [],
    eventContext: CliOptions["eventContext"] = undefined as any,
    runId: string | null = null,
    collect: ((e: BridgeEvent) => void) | null = null,
    chatKey: string = String(chatId),
  ): Promise<CliResult> {
    const executionKind = this._executionKind();
    const model = isAgentKind(this.kind)
      ? (this.db.getSetting(this.kind) || this.opts.botConfig.modelPreference[0] || null)
      : (this.opts.botConfig.modelPreference[0] || null);

    let logFile: string | null = null;
    if (executionKind === "antigravity") {
      logFile = join(tmpdir(), `antigravity-${randomUUID()}.log`);
    }

    const outDir = await prepareOutputDir(chatId, this.kind);
    const cwd = getCliWorkingDir(executionKind);
    const startedAtMs = Date.now();
    if (executionKind === "antigravity") setAntigravityModel(model);
    const promptForCli = this._buildPromptForCli(chatKey, prompt);
    const invocation = buildCliInvocation({
      bot: executionKind,
      command: this.opts.botConfig.command,
      model,
      effort: resolveEffort(executionKind, this.db),
      prompt: promptForCli.prompt,
      sessionId,
      executionMode: this.opts.executionMode,
      outputFormat: executionKind === "antigravity" ? undefined : "json",
      logFile,
      soulContext: this.opts.soulContext,
      attachments,
      outputDir: outDir,
    });
    const isClaudeStreamJson = executionKind === "claude" && !!invocation.stdin;
    try {
      const cliResult = await this.exec.runCliAsync(invocation.command, invocation.args, cwd, {
        ...buildExecutionOptions(executionKind),
        onProgress,
        chatId: chatKey,
        stdin: invocation.stdin,
        contextEnv: promptForCli.contextEnv,
        eventContext,
        onEvent: collect ?? undefined,
      });

      let logContent: string | null = null;
      if (logFile) {
        try { logContent = readFileSync(logFile, "utf8"); } catch {} finally { try { rmSync(logFile); } catch {} }
      }

      let result: CliResult;
      if (isClaudeStreamJson) {
        const parsed = parseClaudeStreamJsonOutput(cliResult.text);
        result = parsed ?? { text: cliResult.text.trim(), sessionId: null };
      } else {
        result = parseCliResult({ bot: executionKind, stdout: cliResult.text, logContent });
      }
      if (executionKind === "antigravity" && !result.sessionId) {
        result.sessionId = resolveAntigravityConversationId({ cwd, sinceMs: startedAtMs, explicitLogContent: logContent });
      }
      if (result?.sessionId && isAgentKind(this.kind)) db_setSession(this.db, chatKey, this.kind, result.sessionId);
      if (isAgentKind(this.kind)) this.db.resetFailures(chatKey, this.kind);
      result.text = scrubOutputDir(result.text, outDir);
      result.text = this._applyMemorySidecars(chatKey, result.text);
      if (isAgentKind(this.kind)) {
        this._rememberTurn(chatKey, prompt, result.text);
        await this._extractPostTurnMemories(chatKey, prompt, result.text, "async");
      }
      if (this.hooks.onAfterExecute) {
        await this.hooks.onAfterExecute(prompt, result.text, hookContext(chatId, chatKey, body.message_thread_id));
      }
      await uploadOutputFiles(outDir, chatId, this.client).catch((err) =>
        console.error(`[${this.kind}] output file upload failed`, err)
      );
      // Emit a richer run.completed with the real sessionId for downstream
      // collectors (e.g. sendMessageWithProgress's onEvent branch). The
      // runCliAsync already emitted a run.completed with sessionId: null;
      // appending a corrected one keeps the event stream coherent.
      if (collect && runId && eventContext) {
        collect({
          type: "run.completed",
          version: 1,
          id: randomUUID(),
          runId,
          timestamp: new Date().toISOString(),
          bot: eventContext.bot,
          chatId: eventContext.chatId,
          threadId: eventContext.threadId,
          sessionId: result.sessionId ?? null,
          text: result.text,
        });
      }
      return result;
    } catch (error) {
      if (logFile) { try { rmSync(logFile); } catch {} }
      await uploadOutputFiles(outDir, chatId, this.client).catch(() => {});
      if (sessionId && /No conversation found with session ID|thread not found|session not found|conversation not found/i.test((error as Error).message ?? "")) {
        console.warn(`[${this.kind}] session ID invalid, retrying with fresh session...`);
        if (isAgentKind(this.kind)) db_setSession(this.db, chatKey, this.kind, null);
        const retryPrompt = this._buildRecentContextPrompt(chatKey, prompt);
        return this.executePromptAsync(retryPrompt, null, chatId, body, onProgress, attachments, eventContext, runId, collect, chatKey);
      }
      if (executionKind === "antigravity" && (isAntigravityPrintTimeoutError(error as Error) || isRecoverableAntigravityExecutionError(error as Error))) {
        return this._retryAntigravityFreshSession(prompt, chatId, chatKey, outDir, onProgress, attachments, "async", eventContext, runId, collect, body.message_thread_id);
      }
      if (isCapacityExhaustedError(error as Error) && this.opts.botConfig.modelPreference.length > 1) {
        const fallbackModel = getNextFallbackModel(model, this.opts.botConfig.modelPreference);
        if (fallbackModel) {
          return this._runWithFallback(prompt, sessionId, chatId, chatKey, fallbackModel, outDir, cwd, startedAtMs, onProgress, attachments, logFile, "async", eventContext, runId, collect);
        }
      }
      this._handleCircuitBreaker(error as Error, chatKey);
      throw error;
    }
  }

  async executePrompt(
    prompt: string,
    sessionId: string | null,
    chatId: number,
    body: any = {},
    attachments: string[] = [],
    eventContext: CliOptions["eventContext"] = undefined as any,
    runId: string | null = null,
    collect: ((e: BridgeEvent) => void) | null = null,
    chatKey: string = String(chatId),
  ): Promise<CliResult> {
    const { message_thread_id: threadId } = body;
    const executionKind = this._executionKind();
    const model = isAgentKind(this.kind)
      ? (this.db.getSetting(this.kind) || this.opts.botConfig.modelPreference[0] || null)
      : (this.opts.botConfig.modelPreference[0] || null);

    let logFile: string | null = null;
    if (executionKind === "antigravity") {
      logFile = join(tmpdir(), `antigravity-${randomUUID()}.log`);
    }

    const outDir = await prepareOutputDir(chatId, this.kind);
    const cwd = getCliWorkingDir(executionKind);
    const startedAtMs = Date.now();
    if (executionKind === "antigravity") setAntigravityModel(model);
    const promptForCli = this._buildPromptForCli(chatKey, prompt);
    const invocation = buildCliInvocation({
      bot: executionKind,
      command: this.opts.botConfig.command,
      model,
      effort: resolveEffort(executionKind, this.db),
      prompt: promptForCli.prompt,
      sessionId,
      sessionMode: "resume",
      executionMode: this.opts.executionMode,
      outputFormat: executionKind === "antigravity" ? undefined : "json",
      logFile,
      soulContext: this.opts.soulContext,
      attachments,
      outputDir: outDir,
    });
    const isClaudeStreamJson = executionKind === "claude" && !!invocation.stdin;
    const typingTracker = createTypingTracker(this.client, chatId, this.kind, { message_thread_id: threadId });

    try {
      await typingTracker.start();
      const stdout = await this.exec.runCli(invocation.command, invocation.args, cwd, {
        ...buildExecutionOptions(executionKind),
        chatId: chatKey,
        stdin: invocation.stdin,
        contextEnv: promptForCli.contextEnv,
        eventContext,
        onEvent: collect ?? undefined,
      });

      let logContent: string | null = null;
      if (logFile) {
        try { logContent = readFileSync(logFile, "utf8"); } catch {} finally { try { rmSync(logFile); } catch {} }
      }

      let result: CliResult;
      if (isClaudeStreamJson) {
        const parsed = parseClaudeStreamJsonOutput(stdout);
        result = parsed ?? { text: stdout.trim(), sessionId: null };
      } else {
        result = parseCliResult({ bot: executionKind, stdout, logContent });
      }
      if (executionKind === "antigravity" && !result.sessionId) {
        result.sessionId = resolveAntigravityConversationId({ cwd, sinceMs: startedAtMs, explicitLogContent: logContent });
      }
      if (result.sessionId && isAgentKind(this.kind)) db_setSession(this.db, chatKey, this.kind, result.sessionId);
      if (isAgentKind(this.kind)) this.db.resetFailures(chatKey, this.kind);
      result.text = scrubOutputDir(result.text, outDir);
      result.text = this._applyMemorySidecars(chatKey, result.text);
      if (isAgentKind(this.kind)) {
        this._rememberTurn(chatKey, prompt, result.text);
        await this._extractPostTurnMemories(chatKey, prompt, result.text, "sync");
      }
      if (this.hooks.onAfterExecute) {
        await this.hooks.onAfterExecute(prompt, result.text, hookContext(chatId, chatKey, body.message_thread_id));
      }
      await uploadOutputFiles(outDir, chatId, this.client).catch((err) =>
        console.error(`[${this.kind}] output file upload failed`, err)
      );
      if (collect && runId && eventContext) {
        collect({
          type: "run.completed",
          version: 1,
          id: randomUUID(),
          runId,
          timestamp: new Date().toISOString(),
          bot: eventContext.bot,
          chatId: eventContext.chatId,
          threadId: eventContext.threadId,
          sessionId: result.sessionId ?? null,
          text: result.text,
        });
      }
      return result;
    } catch (error) {
      if (logFile) { try { rmSync(logFile); } catch {} }
      await uploadOutputFiles(outDir, chatId, this.client).catch(() => {});
      if (sessionId && /No conversation found with session ID|thread not found|session not found|conversation not found/i.test((error as Error).message ?? "")) {
        console.warn(`[${this.kind}] session ID invalid, retrying with fresh session...`);
        if (isAgentKind(this.kind)) db_setSession(this.db, chatKey, this.kind, null);
        const retryPrompt = this._buildRecentContextPrompt(chatKey, prompt);
        return this.executePrompt(retryPrompt, null, chatId, body, attachments, eventContext, runId, collect, chatKey);
      }
      if (executionKind === "antigravity" && (isAntigravityPrintTimeoutError(error as Error) || isRecoverableAntigravityExecutionError(error as Error))) {
        return this._retryAntigravityFreshSession(prompt, chatId, chatKey, outDir, () => {}, attachments, "sync", eventContext, runId, collect, body.message_thread_id);
      }
      if (isCapacityExhaustedError(error as Error) && this.opts.botConfig.modelPreference.length > 1) {
        const fallbackModel = getNextFallbackModel(model, this.opts.botConfig.modelPreference);
        if (fallbackModel) {
          return this._runWithFallback(prompt, sessionId, chatId, chatKey, fallbackModel, outDir, cwd, startedAtMs, () => {}, attachments, logFile, "sync", eventContext, runId, collect);
        }
      }
      this._handleCircuitBreaker(error as Error, chatKey);
      throw error;
    } finally {
      await typingTracker.stop();
    }
  }

  private async _runFreshAntigravityRetry(
    prompt: string,
    chatId: number,
    chatKey: string,
    outDir: string,
    onProgress: (t: string) => void,
    attachments: string[],
    mode: "async" | "sync",
    eventContext: CliOptions["eventContext"] = undefined as any,
    runId: string | null = null,
    collect: ((e: BridgeEvent) => void) | null = null,
  ): Promise<CliResult> {
    const executionKind = this._executionKind();
    const model = isAgentKind(this.kind)
      ? (this.db.getSetting(this.kind) || this.opts.botConfig.modelPreference[0] || null)
      : (this.opts.botConfig.modelPreference[0] || null);
    const retryLogFile = join(tmpdir(), `antigravity-${randomUUID()}.log`);
    const retryCwd = getCliWorkingDir(executionKind);
    const retryStartedAtMs = Date.now();
    setAntigravityModel(model);
    const retryInvocation = buildCliInvocation({
      bot: executionKind,
      command: this.opts.botConfig.command,
      model,
      prompt,
      sessionId: null,
      sessionMode: "resume",
      executionMode: this.opts.executionMode,
      outputFormat: undefined,
      logFile: retryLogFile,
      soulContext: this.opts.soulContext,
      outputDir: outDir,
      attachments,
    });

    try {
      const rawResult = mode === "async"
        ? (await this.exec.runCliAsync(retryInvocation.command, retryInvocation.args, retryCwd, {
            ...buildExecutionOptions(executionKind),
            onProgress,
            chatId: chatKey,
            stdin: retryInvocation.stdin,
            eventContext,
            onEvent: collect ?? undefined,
          })).text
        : await this.exec.runCli(retryInvocation.command, retryInvocation.args, retryCwd, {
            ...buildExecutionOptions(executionKind),
            chatId: chatKey,
            stdin: retryInvocation.stdin,
            eventContext,
            onEvent: collect ?? undefined,
          });

      let retryLogContent: string | null = null;
      try { retryLogContent = readFileSync(retryLogFile, "utf8"); } catch {}
      finally { try { rmSync(retryLogFile); } catch {} }

      const result = parseCliResult({ bot: executionKind, stdout: rawResult, logContent: retryLogContent });
      if (!result.sessionId) {
        result.sessionId = resolveAntigravityConversationId({ cwd: retryCwd, sinceMs: retryStartedAtMs, explicitLogContent: retryLogContent });
      }
      if (result.sessionId && isAgentKind(this.kind)) db_setSession(this.db, chatKey, this.kind, result.sessionId);
      if (isAgentKind(this.kind)) this.db.resetFailures(chatKey, this.kind);
      result.text = scrubOutputDir(result.text, outDir);
      if (collect && runId && eventContext) {
        collect({
          type: "run.completed",
          version: 1,
          id: randomUUID(),
          runId,
          timestamp: new Date().toISOString(),
          bot: eventContext.bot,
          chatId: eventContext.chatId,
          threadId: eventContext.threadId,
          sessionId: result.sessionId ?? null,
          text: result.text,
        });
      }
      return result;
    } catch (retryError) {
      try { rmSync(retryLogFile); } catch {}
      throw retryError;
    }
  }

  private async _retryAntigravityFreshSession(
    prompt: string,
    chatId: number,
    chatKey: string,
    outDir: string,
    onProgress: (t: string) => void,
    attachments: string[],
    mode: "async" | "sync",
    eventContext: CliOptions["eventContext"] = undefined as any,
    runId: string | null = null,
    collect: ((e: BridgeEvent) => void) | null = null,
    bodyThreadId?: number | string,
  ): Promise<CliResult> {
    if (isAgentKind(this.kind)) db_setSession(this.db, chatKey, this.kind, null);
    const retryPrompt = this._buildRecentContextPrompt(chatKey, prompt);
    const retryResult = await this._runFreshAntigravityRetry(
      retryPrompt,
      chatId,
      chatKey,
      outDir,
      onProgress,
      attachments,
      mode,
      eventContext,
      runId,
      collect,
    );
    retryResult.text = this._applyMemorySidecars(chatKey, retryResult.text);
    this._rememberTurn(chatKey, prompt, retryResult.text);
    await this._extractPostTurnMemories(chatKey, prompt, retryResult.text, mode);
    if (this.hooks.onAfterExecute) {
      await this.hooks.onAfterExecute(prompt, retryResult.text, hookContext(chatId, chatKey, bodyThreadId));
    }
    return retryResult;
  }

  private async _runWithFallback(
    prompt: string,
    sessionId: string | null,
    chatId: number,
    chatKey: string,
    fallbackModel: string,
    outDir: string,
    cwd: string,
    _startedAtMs: number,
    onProgress: (t: string) => void,
    attachments: string[],
    _logFile: string | null,
    mode: "async" | "sync",
    eventContext: CliOptions["eventContext"] = undefined as any,
    runId: string | null = null,
    collect: ((e: BridgeEvent) => void) | null = null,
  ): Promise<CliResult> {
    const executionKind = this._executionKind();
    let fallbackLogFile: string | null = null;
    if (executionKind === "antigravity") {
      fallbackLogFile = join(tmpdir(), `antigravity-${randomUUID()}.log`);
    }
    if (executionKind === "antigravity") setAntigravityModel(fallbackModel);
    const fallbackInvocation = buildCliInvocation({
      bot: executionKind,
      command: this.opts.botConfig.command,
      model: fallbackModel,
      effort: resolveEffort(executionKind, this.db),
      prompt: this._buildRecentContextPrompt(chatKey, prompt),
      sessionId: null,
      sessionMode: "resume",
      executionMode: this.opts.executionMode,
      outputFormat: executionKind === "antigravity" ? undefined : "json",
      logFile: fallbackLogFile,
      soulContext: this.opts.soulContext,
      outputDir: outDir,
      attachments,
    });

    try {
      const fallbackCwd = getCliWorkingDir(executionKind);
      const fallbackStartedAtMs = Date.now();
      const rawResult = mode === "async"
        ? (await this.exec.runCliAsync(fallbackInvocation.command, fallbackInvocation.args, fallbackCwd, {
            ...buildExecutionOptions(executionKind),
            onProgress,
            chatId: chatKey,
            stdin: fallbackInvocation.stdin,
            eventContext,
            onEvent: collect ?? undefined,
          })).text
        : await this.exec.runCli(fallbackInvocation.command, fallbackInvocation.args, fallbackCwd, {
            ...buildExecutionOptions(executionKind),
            chatId: chatKey,
            stdin: fallbackInvocation.stdin,
            eventContext,
            onEvent: collect ?? undefined,
          });

      let fallbackLogContent: string | null = null;
      if (fallbackLogFile) {
        try { fallbackLogContent = readFileSync(fallbackLogFile, "utf8"); } catch {}
        finally { try { rmSync(fallbackLogFile); } catch {} }
      }

      const result = parseCliResult({ bot: executionKind, stdout: rawResult, logContent: fallbackLogContent });
      if (executionKind === "antigravity" && !result.sessionId) {
        result.sessionId = resolveAntigravityConversationId({ cwd: fallbackCwd, sinceMs: fallbackStartedAtMs, explicitLogContent: fallbackLogContent });
      }
      if (result.sessionId && isAgentKind(this.kind)) db_setSession(this.db, chatKey, this.kind, result.sessionId);
      if (isAgentKind(this.kind)) this.db.resetFailures(chatKey, this.kind);
      const currentModel = isAgentKind(this.kind) ? (this.db.getSetting(this.kind) || this.opts.botConfig.modelPreference[0] || null) : null;
      const finalResult = {
        ...result,
        text: `⚠️ Fell back to ${fallbackModel} (${currentModel || "default"} at capacity)\n\n${result.text}`,
      };
      finalResult.text = this._applyMemorySidecars(chatKey, finalResult.text);
      if (isAgentKind(this.kind)) {
        this._rememberTurn(chatKey, prompt, finalResult.text);
        await this._extractPostTurnMemories(chatKey, prompt, finalResult.text, mode);
      }
      if (this.hooks.onAfterExecute) {
        await this.hooks.onAfterExecute(prompt, finalResult.text, hookContext(chatId, chatKey, eventContext?.threadId));
      }
      return finalResult;
    } catch (fallbackError) {
      if (fallbackLogFile) { try { rmSync(fallbackLogFile); } catch {} }
      throw fallbackError;
    }
  }

  private _handleCircuitBreaker(error: Error, chatKey: string): void {
    if (!isAgentKind(this.kind)) return;
    const msg = error.message ?? "";
    if (/timeout|killed by signal/i.test(msg)) {
      const failures = this.db.incrementFailures(chatKey, this.kind);
      if (failures >= 2) {
        console.warn(`[${this.kind}] clearing session after ${failures} consecutive failures for ${chatKey}`);
        db_setSession(this.db, chatKey, this.kind, null);
        this.db.resetFailures(chatKey, this.kind);
      }
    } else if (/No conversation found with session ID|thread not found|session not found|conversation not found/i.test(msg)) {
      console.warn(`[${this.kind}] clearing invalid session ID for ${chatKey}`);
      db_setSession(this.db, chatKey, this.kind, null);
      this.db.resetFailures(chatKey, this.kind);
    }
  }

  async handleCallback(callbackQuery: TelegramCallbackQuery): Promise<void> {
    const fromId = callbackQuery?.from?.id;
    if (!this.opts.allowedUserIds.has(String(fromId))) return;
    if (!isAgentKind(this.kind) || !this.opts.fullConfig) return;

    const data = String(callbackQuery?.data || "");
    const [action, targetKind, ...rest] = data.split(":");
    if (!["model", "effort"].includes(action) || targetKind !== this.kind) return;

    const value = rest.join(":").trim();
    const messageId = callbackQuery.message?.message_id;
    const chatId = callbackQuery.message?.chat?.id;
    if (!chatId || !messageId) return;

    if (action === "effort") {
      const next = value === "reset" ? resolveDefaultEffort(this.kind) : value;
      if (!isEffortLevel(next)) {
        await this.client.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: "Unsupported effort" });
        return;
      }
      this.db.setSetting(effortSettingKey(this.kind), value === "reset" ? null : next);
      await this.client.answerCallbackQuery({ callback_query_id: callbackQuery.id });
      await this.client.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: buildEffortText(this.kind, next),
        reply_markup: buildEffortKeyboard(this.kind, next),
      });
      await this.sendText(chatId, { text: `✓ Effort set to ${next}` });
      return;
    }

    if (value === "reset") {
      this.db.setSetting(this.kind, null);
      if (this.kind === "antigravity") setAntigravityModel(null);
      await this.client.answerCallbackQuery({
        callback_query_id: callbackQuery.id,
        text: `${this.kind} reset to default`,
      });
      await this.client.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: buildModelsText(this.kind, { db: this.db, config: this.opts.fullConfig }),
        reply_markup: buildModelKeyboard(this.kind, this.opts.botConfig.modelPreference, null),
      });
      return;
    }

    this.db.setSetting(this.kind, value);
    if (this.kind === "antigravity") setAntigravityModel(value);
    await this.client.answerCallbackQuery({ callback_query_id: callbackQuery.id });
    await this.client.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text: buildModelsText(this.kind, { db: this.db, config: this.opts.fullConfig }),
      reply_markup: buildModelKeyboard(this.kind, this.opts.botConfig.modelPreference, value),
    });
    await this.sendText(chatId, { text: `✓ Model set to ${value}` });
  }

  async sendText(chatId: number, body: any): Promise<void> {
    await sendTelegramMessage({ client: this.client, kind: this._deliveryKind(), chatId, body });
  }

  private _executionKind(): BotKind {
    return isAgentKind(this.kind) ? this.kind : (this.opts.executionKind ?? "claude");
  }

  private _deliveryKind(): string {
    return this._executionKind();
  }

  /** Returns fullConfig if provided, otherwise builds a minimal BridgeConfig from engine options. */
  private _effectiveConfig(): BridgeConfig {
    if (this.opts.fullConfig) return this.opts.fullConfig;
    const kind = this.kind as BotKind;
    const emptyBot = { token: undefined, command: "", modelPreference: [] };
    return {
      allowedUserIds: this.opts.allowedUserIds,
      serviceEnvFile: null,
      serviceKind: isAgentKind(this.kind) ? kind : null,
      pollIntervalMs: this.opts.pollIntervalMs,
      executionMode: this.opts.executionMode,
      asyncEnabled: this.opts.asyncEnabled,
      dbPath: "",
      bots: {
        codex: this.kind === "codex" ? { token: undefined, command: this.opts.botConfig.command, modelPreference: this.opts.botConfig.modelPreference } : emptyBot,
        antigravity: this.kind === "antigravity" ? { token: undefined, command: this.opts.botConfig.command, modelPreference: this.opts.botConfig.modelPreference } : emptyBot,
        claude: this.kind === "claude" ? { token: undefined, command: this.opts.botConfig.command, modelPreference: this.opts.botConfig.modelPreference } : emptyBot,
      },
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function db_setSession(db: BridgeDb, chatKey: string, kind: BotKind, sessionId: string | null) {
  try {
    db.setSession(chatKey, kind, sessionId);
  } catch {
    // ignore — non-agent kinds are not tracked
  }
}
