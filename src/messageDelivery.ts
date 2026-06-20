import { splitTelegramText, toTelegramEntitiesText, renderTelegramEntitiesFromIR } from "./render.js";
import { toUserMessage, isCapacityExhaustedError } from "./cli.js";
import type { MessagingPlatform } from "./platform.js";
import type { CliResult } from "./types.js";
import { type as eventType } from "./events/types.js";
import type { BridgeEvent } from "./events/types.js";
import { reduce as reduceEvents } from "./events/reducer.js";
import { runViewToTelegramText } from "./events/telegramAdapter.js";
import {
  documentFallbackEnabled,
  flattenMarkdownTablesToCards,
  markdownTableToRichHtml,
  richMessagesEnabled,
  routeNativeLayout,
} from "./nativeLayout.js";
import { telegramMarkdownIrEnabled, parseMarkdownToIR, renderMarkerString, TELEGRAM_HTML_MARKERS, TELEGRAM_RICH_HTML_MARKERS } from "./markdownIR.js";

const MAX_TELEGRAM_TEXT = 4096;

function truncate(text: string): string {
  return text.length > MAX_TELEGRAM_TEXT ? text.slice(-MAX_TELEGRAM_TEXT) : text;
}

function extractStatusProgress(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^STATUS:\s+\S/i.test(line))
    .map((line) => line.replace(/^STATUS:\s*/i, ""))
    .join("\n")
    .trim();
}

function extractCodexProgressText(chunk: string): string {
  const lines = chunk.split("\n").map((line) => line.trim()).filter(Boolean);
  const parts: string[] = [];

  for (const line of lines) {
    if (!line.startsWith("{")) {
      parts.push(line);
      continue;
    }

    try {
      const event = JSON.parse(line);
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        parts.push(event.delta);
      } else if (
        (event.type === "item.completed" || event.type === "item.updated") &&
        event.item?.type === "agent_message" &&
        typeof event.item.text === "string"
      ) {
        parts.push(event.item.text);
      } else if (event.type === "response.completed" && typeof event.output_text === "string") {
        parts.push(event.output_text);
      }
    } catch {
      parts.push(line);
    }
  }

  return parts.join("\n").trim();
}

export async function sendTelegramMessage({
  client,
  kind,
  chatId,
  body,
}: {
  client: MessagingPlatform;
  kind: string;
  chatId: number;
  body: any;
}): Promise<void> {
  const text = String(body.text || "");
  const { text: _ignored, ...rest } = body;
  const route = routeNativeLayout(text, {
    documentEnabled: documentFallbackEnabled(),
    richEnabled: richMessagesEnabled() && typeof client.sendRichMessage === "function",
  });

  if (route.kind === "document" && typeof client.sendDocumentBuffer === "function") {
    await client.sendDocumentBuffer({
      chat_id: chatId,
      ...rest,
      bytes: Buffer.from(text, "utf8"),
      filename: "response.md",
      mime_type: "text/markdown",
      caption: `Full response attached as response.md (${route.reason})`,
    });
    return;
  }

  if (route.kind === "rich" && typeof client.sendRichMessage === "function") {
    try {
      await client.sendRichMessage({
        chat_id: chatId,
        ...rest,
        rich_message: {
          html: telegramMarkdownIrEnabled()
            ? renderMarkerString(parseMarkdownToIR(text), TELEGRAM_RICH_HTML_MARKERS)
            : markdownTableToRichHtml(text),
        },
      });
      return;
    } catch (err) {
      console.warn(`[${kind}] rich message failed; falling back to native HTML`, err);
    }
  }

  if ((route.kind === "html" || route.kind === "rich") && !telegramMarkdownIrEnabled()) {
    try {
      await client.sendMessage({
        chat_id: chatId,
        ...rest,
        text: flattenMarkdownTablesToCards(text),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      return;
    } catch (err) {
      console.warn(`[${kind}] native HTML message failed; falling back to plain text`, err);
    }
  }

  await sendEntityMessages({ client, chatId, body: { ...rest, text } });
}

async function sendEntityMessages({
  client,
  chatId,
  body,
}: {
  client: MessagingPlatform;
  chatId: number;
  body: any;
}): Promise<void> {
  const chunks = splitTelegramText(String(body.text || ""));
  const { text: _ignored, ...rest } = body;

  for (let i = 0; i < chunks.length; i += 1) {
    const chunkText = chunks[i];
    const chunkBody: any = {
      chat_id: chatId,
      ...rest,
      text: chunkText,
    };

    if (i > 0) delete chunkBody.reply_markup;
    const ep = telegramMarkdownIrEnabled()
      ? renderTelegramEntitiesFromIR(parseMarkdownToIR(chunkText))
      : toTelegramEntitiesText(chunkText);
    chunkBody.text = ep.text;
    if (ep.entities.length > 0) chunkBody.entities = ep.entities;
    await client.sendMessage(chunkBody);
  }
}

function validateParity({
  kind,
  chatId,
  runId,
  finalText,
  errorText,
  sessionId,
}: {
  kind: string;
  chatId: number;
  runId?: string;
  finalText?: string;
  errorText?: string;
  sessionId?: string | null;
}) {
  try {
    const valRunId = runId || `val-${Math.random().toString(36).substring(2)}`;
    const events: BridgeEvent[] = [
      eventType.runStarted({
        runId: valRunId,
        bot: kind as any,
        chatId: String(chatId),
        command: "validation",
        cwd: process.cwd(),
        model: null,
      }),
    ];

    let expectedText = "";
    if (errorText) {
      expectedText = errorText;
      events.push(
        eventType.runFailed({
          runId: valRunId,
          bot: kind as any,
          chatId: String(chatId),
          error: errorText.startsWith("❌ ") ? errorText.slice(2) : errorText,
          category: "cli",
        })
      );
    } else {
      expectedText = finalText || "";
      events.push(
        eventType.runCompleted({
          runId: valRunId,
          bot: kind as any,
          chatId: String(chatId),
          text: expectedText,
          sessionId: sessionId || null,
        })
      );
    }

    const view = reduceEvents(events);
    const eventText = runViewToTelegramText(view);

    const cleanExpected = toTelegramEntitiesText(expectedText).text;
    const cleanEvent = eventText;

    if (cleanEvent !== cleanExpected) {
      console.warn(
        `[validation] Output mismatch for run ${valRunId}: legacy="${cleanExpected}" vs event="${cleanEvent}"`
      );
    }
  } catch (valErr) {
    console.warn(`[validation] Parity check failed to execute`, valErr);
  }
}

export async function sendMessageWithProgress({
  client,
  kind,
  chatId,
  execution,
  onProgress = () => {},
  body = {},
  showProgressNarration = false,
  isAborted,
  runId,
  onEvent,
}: {
  client: MessagingPlatform;
  kind: string;
  chatId: number;
  execution: ((onProgress: (text: string) => void) => Promise<CliResult>) | Promise<CliResult>;
  onProgress?: (text: string) => void;
  body?: any;
  showProgressNarration?: boolean;
  isAborted?: () => boolean;
  runId?: string;
  onEvent?: (event: BridgeEvent) => void;
}): Promise<CliResult | null> {
  const { text: _ignored, ...rest } = body;

  const sendTyping = async () => {
    try {
      await client.sendChatAction({ chat_id: chatId, ...rest, action: "typing" });
    } catch {
      /* ignore */
    }
  };

  await sendTyping();
  const typingInterval = setInterval(sendTyping, 4500);

  // For antigravity: raw reasoning/progress should keep Telegram's typing
  // indicator alive. Visible narration is opt-in and only shows sanitized
  // STATUS lines, never generic thinking notes or raw pre-final narration.
  const streamingEnabled = kind === "antigravity";
  let progressMsgId: number | null = null;
  let progressMsgPending = false;
  const progressUpdates: Promise<unknown>[] = [];

  let currentText = "";
  let lastProgressEditMs = 0;
  let lastSentPreviewText = "";
  const PROGRESS_EDIT_INTERVAL_MS = 5_000;
  const originalOnProgress = onProgress;

  const wrappedOnProgress = (chunk: string) => {
    currentText += chunk;
    originalOnProgress?.(chunk);

    if (streamingEnabled) {
      sendTyping();
      if (!showProgressNarration) return;
      const now = Date.now();
      if (now - lastProgressEditMs >= PROGRESS_EDIT_INTERVAL_MS) {
        lastProgressEditMs = now;
        const previewText = truncate(extractStatusProgress(currentText));
        if (!previewText) return;
        if (previewText === lastSentPreviewText) return;
        lastSentPreviewText = previewText;
        if (progressMsgId == null) {
          if (progressMsgPending) return;
          progressMsgPending = true;
          const update = client.sendMessage({ chat_id: chatId, ...body, text: previewText })
            .then((sent: any) => { progressMsgId = sent?.result?.message_id ?? null; })
            .catch(() => { /* ignore send failures during streaming */ })
            .finally(() => { progressMsgPending = false; });
          progressUpdates.push(update);
          return;
        }
        const update = client.editMessageText({
          chat_id: chatId,
          message_id: progressMsgId,
          ...body,
          text: previewText,
        }).catch(() => { /* ignore edit failures during streaming */ });
        progressUpdates.push(update);
      }
    }
  };

  async function deliverFinal(text: string): Promise<void> {
    await Promise.allSettled(progressUpdates);
    if (streamingEnabled && progressMsgId != null) {
      try {
        await client.editMessageText({
          chat_id: chatId,
          message_id: progressMsgId,
          ...body,
          text: truncate(text),
        });
        return;
      } catch (editErr: any) {
        const msg = String(editErr?.message ?? editErr);
        if (msg.includes("message is not modified")) return;
        /* fall through to sendTelegramMessage if edit fails */
      }
    }
    await sendTelegramMessage({ client, kind, chatId, body: { ...body, text } });
  }

  try {
    let result: any;
    if (typeof execution === "function") {
      result = await execution(wrappedOnProgress);
    } else {
      result = await execution;
    }

    const finalText = result?.text || currentText || "";

    if (isAborted?.()) {
      clearInterval(typingInterval);
      return result;
    }

    validateParity({
      kind,
      chatId,
      runId,
      finalText,
      sessionId: result?.sessionId,
    });

    await deliverFinal(finalText);

    clearInterval(typingInterval);
    return { ...result, onProgress: wrappedOnProgress };
  } catch (err: any) {
    clearInterval(typingInterval);
    if (isCapacityExhaustedError(err instanceof Error ? err : new Error(String(err)))) {
      throw err;
    }
    const errorText = `❌ ${toUserMessage(err instanceof Error ? err : new Error(String(err)))}`;
    validateParity({
      kind,
      chatId,
      runId,
      errorText,
    });
    await deliverFinal(errorText);
    console.error(`[${kind}] execution error`, err);
    return null;
  }
}
