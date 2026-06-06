import { splitTelegramText, toTelegramEntitiesText } from "./render.js";
import { toUserMessage } from "./cli.js";
import type { TelegramClient } from "./telegram.js";
import type { CliResult } from "./types.js";
import { type as eventType } from "./events/types.js";
import type { BridgeEvent } from "./events/types.js";
import { reduce as reduceEvents } from "./events/reducer.js";
import { runViewToTelegramText } from "./events/telegramAdapter.js";

const MAX_TELEGRAM_TEXT = 4096;

function truncate(text: string): string {
  return text.length > MAX_TELEGRAM_TEXT ? text.slice(-MAX_TELEGRAM_TEXT) : text;
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
  client: TelegramClient;
  kind: string;
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
    const ep = toTelegramEntitiesText(chunkText);
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
  isAborted,
  runId,
  onEvent,
}: {
  client: TelegramClient;
  kind: string;
  chatId: number;
  execution: ((onProgress: (text: string) => void) => Promise<CliResult>) | Promise<CliResult>;
  onProgress?: (text: string) => void;
  body?: any;
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

  if (onEvent && runId) {
    onEvent(eventType.runStarted({
      runId,
      bot: kind as any,
      chatId: String(chatId),
      command: "mock",
      cwd: process.cwd(),
      model: null,
    }));
  }

  let currentText = "";
  const originalOnProgress = onProgress;
  const wrappedOnProgress = (chunk: string) => {
    currentText += chunk;
    originalOnProgress?.(chunk);
  };

  try {
    let result: any;
    if (typeof execution === "function") {
      result = await execution(wrappedOnProgress);
    } else {
      result = await execution;
    }

    const finalText = result?.text || currentText || "";

    if (isAborted?.()) return result;

    validateParity({
      kind,
      chatId,
      runId,
      finalText,
      sessionId: result?.sessionId,
    });

    if (onEvent && runId) {
      const completedEvent = eventType.runCompleted({
        runId,
        bot: kind as any,
        chatId: String(chatId),
        text: finalText,
        sessionId: result?.sessionId || null,
      });
      onEvent(completedEvent);

      const view = reduceEvents([
        eventType.runStarted({
          runId,
          bot: kind as any,
          chatId: String(chatId),
          command: "mock",
          cwd: process.cwd(),
          model: null,
        }),
        completedEvent
      ]);

      const eventText = runViewToTelegramText(view);
      await sendTelegramMessage({ client, kind, chatId, body: { ...body, text: eventText } });
    } else {
      await sendTelegramMessage({ client, kind, chatId, body: { ...body, text: finalText } });
    }

    clearInterval(typingInterval);
    return { ...result, onProgress: wrappedOnProgress };
  } catch (err: any) {
    clearInterval(typingInterval);
    const errorText = `❌ ${toUserMessage(err instanceof Error ? err : new Error(String(err)))}`;
    validateParity({
      kind,
      chatId,
      runId,
      errorText,
    });
    await sendTelegramMessage({ client, kind, chatId, body: { ...body, text: errorText } });
    console.error(`[${kind}] execution error`, err);
    return null;
  }
}
