import { splitTelegramText, escapeTelegramMarkdownV2, toTelegramEntitiesText } from "./render.js";
import { toUserMessage } from "./cli.js";
import type { TelegramClient } from "./telegram.js";
import type { CliResult } from "./types.js";

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
  const isGeminiOrAntigravity = kind === "gemini" || kind === "antigravity";

  for (let i = 0; i < chunks.length; i += 1) {
    const chunkText = chunks[i];
    const chunkBody: any = {
      chat_id: chatId,
      ...rest,
      text: chunkText,
      parse_mode: isGeminiOrAntigravity ? undefined : "MarkdownV2",
    };

    if (isGeminiOrAntigravity) {
      const ep = toTelegramEntitiesText(chunkText);
      chunkBody.text = ep.text;
      if (ep.entities.length > 0) chunkBody.entities = ep.entities;
      delete chunkBody.parse_mode;
      await client.sendMessage(chunkBody);
      continue;
    }

    if (i > 0) delete chunkBody.reply_markup;

    try {
      await client.sendMessage(chunkBody);
    } catch (error: any) {
      try {
        console.warn(`[${kind}] Raw MarkdownV2 failed, trying escaped`, error.message);
        await client.sendMessage({ ...chunkBody, text: escapeTelegramMarkdownV2(chunks[i]) });
      } catch (escapeError: any) {
        console.warn(`[${kind}] Escaped MarkdownV2 failed, falling back to plain text`, escapeError.message);
        const plainBody = { ...chunkBody, text: chunks[i] };
        delete plainBody.parse_mode;
        await client.sendMessage(plainBody);
      }
    }
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
}: {
  client: TelegramClient;
  kind: string;
  chatId: number;
  execution: ((onProgress: (text: string) => void) => Promise<CliResult>) | Promise<CliResult>;
  onProgress?: (text: string) => void;
  body?: any;
  isAborted?: () => boolean;
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
    await sendTelegramMessage({ client, kind, chatId, body: { ...body, text: finalText } });

    clearInterval(typingInterval);
    return { ...result, onProgress: wrappedOnProgress };
  } catch (err: any) {
    clearInterval(typingInterval);
    const errorText = `❌ ${toUserMessage(err instanceof Error ? err : new Error(String(err)))}`;
    await sendTelegramMessage({ client, kind, chatId, body: { ...body, text: errorText } });
    console.error(`[${kind}] execution error`, err);
    return null;
  }
}
