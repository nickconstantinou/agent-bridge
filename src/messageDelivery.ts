import { splitTelegramText, escapeTelegramMarkdownV2, toTelegramEntitiesText } from "./render.js";
import type { TelegramClient } from "./telegram.js";
import type { TelegramMessage, CliResult } from "./types.js";

export async function sendTelegramMessage({
  client,
  outbox,
  kind,
  chatId,
  body,
}: {
  client: TelegramClient;
  outbox: any;
  kind: string;
  chatId: number;
  body: any;
}): Promise<void> {
  const chunks = splitTelegramText(String(body.text || ""));
  const { text: _ignored, ...rest } = body;
  const isGemini = kind === "gemini";

  for (let i = 0; i < chunks.length; i += 1) {
    const chunkText = chunks[i];
    const chunkBody: any = {
      chat_id: chatId,
      ...rest,
      text: chunkText,
      parse_mode: isGemini ? undefined : "MarkdownV2",
    };

    if (isGemini) {
      const entitiesPayload = toTelegramEntitiesText(chunkText);
      chunkBody.text = entitiesPayload.text;
      if (entitiesPayload.entities.length > 0) chunkBody.entities = entitiesPayload.entities;
      delete chunkBody.parse_mode;
    }

    if (i > 0) delete chunkBody.reply_markup;

    if (isGemini) {
      await outbox.send(chatId, chunkBody, (message: any) => client.sendMessage(message));
      continue;
    }

    try {
      await outbox.send(chatId, chunkBody, (message: any) => client.sendMessage(message));
    } catch (error: any) {
      try {
        console.warn(`[${kind}] Raw MarkdownV2 failed, trying escaped`, error.message);
        const escapedBody = { ...chunkBody, text: escapeTelegramMarkdownV2(chunks[i]) };
        await outbox.send(chatId, escapedBody, (message: any) => client.sendMessage(message));
      } catch (escapeError: any) {
        console.warn(`[${kind}] Escaped MarkdownV2 failed, falling back to plain text`, escapeError.message);
        const plainBody = { ...chunkBody, text: chunks[i] };
        delete plainBody.parse_mode;
        await outbox.send(chatId, plainBody, (message: any) => client.sendMessage(message));
      }
    }
  }
}

/**
 * Send a message with progress streaming.
 * Sends initial placeholder, streams updates via editMessageText, replaces on final.
 */
export async function sendMessageWithProgress({
  client,
  outbox,
  kind,
  chatId,
  execution,
  placeholderText = "🤔 Thinking...",
  onProgress = () => {},
  body = {},
}: {
  client: TelegramClient;
  outbox: any;
  kind: string;
  chatId: number;
  execution: ((onProgress: (text: string) => void) => Promise<CliResult>) | Promise<CliResult>;
  placeholderText?: string;
  onProgress?: (text: string) => void;
  body?: any;
}): Promise<CliResult | any> {
  const isGemini = kind === "gemini";
  const { text: _ignored, ...rest } = body;

  const sendTyping = async () => {
    try {
      await outbox.send(chatId, { chat_id: chatId, ...rest, action: "typing" }, (msg: any) => client.sendChatAction(msg));
    } catch {
      /* ignore */
    }
  };

  // 1. Send typing indicator
  await sendTyping();
  const typingInterval = setInterval(sendTyping, 4500);

  // 2. Send placeholder message
  const placeholderBody = {
    chat_id: chatId,
    ...rest,
    text: placeholderText,
  };
  let placeholderMsg: any;
  try {
    placeholderMsg = await outbox.send(chatId, placeholderBody, (msg: any) => client.sendMessage(msg));
  } catch (err) {
    clearInterval(typingInterval);
    throw err;
  }

  const placeholderMessageId = placeholderMsg?.result?.message_id;

  let lastUpdateMs = Date.now();
  let currentText = "";
  const UPDATE_INTERVAL_MS = 2000;

  const MAX_TELEGRAM_TEXT = 4096;

  const flushProgress = async (text: string, isFinal = false) => {
    currentText = text;
    const now = Date.now();
    if (!isFinal && now - lastUpdateMs < UPDATE_INTERVAL_MS) return;
    if (!placeholderMessageId) return;

    lastUpdateMs = now;
    const raw = currentText || "...";
    // Telegram rejects edits longer than 4096 chars; keep the tail (most recent output).
    const editText = raw.length > MAX_TELEGRAM_TEXT ? raw.slice(-MAX_TELEGRAM_TEXT) : raw;
    try {
      const editBody: any = {
        chat_id: chatId,
        message_id: placeholderMessageId,
        ...rest,
        text: editText,
      };

      if (isGemini) {
        const entitiesPayload = toTelegramEntitiesText(editText);
        editBody.text = entitiesPayload.text;
        if (entitiesPayload.entities.length > 0) editBody.entities = entitiesPayload.entities;
      }

      await client.editMessageText(editBody);
    } catch (err: any) {
      console.warn(`[${kind}] progress edit failed`, err.message);
    }
  };

  // Wrap onProgress to flush to Telegram
  const originalOnProgress = onProgress;
  const wrappedOnProgress = (chunk: string) => {
    const newText = (currentText || "") + chunk;
    void flushProgress(newText, false);
    originalOnProgress?.(chunk);
  };

  try {
    // 3. Wait for execution, streaming progress
    let result: any;
    if (typeof execution === "function") {
      result = await execution(wrappedOnProgress);
    } else {
      result = await execution;
    }

    const finalText = result?.text || currentText || "";

    // 4. Replace placeholder with final result
    if (placeholderMessageId) {
      try {
        // editMessageText has a 4096 char limit; slice to avoid MESSAGE_TOO_LONG
        const editText = finalText.length > MAX_TELEGRAM_TEXT ? finalText.slice(-MAX_TELEGRAM_TEXT) : finalText;
        const finalBody: any = {
          chat_id: chatId,
          message_id: placeholderMessageId,
          ...rest,
          text: editText,
        };

        if (isGemini) {
          const entitiesPayload = toTelegramEntitiesText(editText);
          finalBody.text = entitiesPayload.text;
          if (entitiesPayload.entities.length > 0) finalBody.entities = entitiesPayload.entities;
        }

        await client.editMessageText(finalBody);
      } catch (editErr: any) {
        // "message is not modified" means progress streaming already set this text — not an error
        if (editErr.message?.includes("message is not modified")) return;
        // Fallback: send new message if edit fails for any other reason
        console.warn(`[${kind}] final edit failed, sending new message`, editErr.message);
        await sendTelegramMessage({ client, outbox, kind, chatId, body: { ...body, text: finalText } });
      }
    } else {
      // No placeholder, send fresh
      await sendTelegramMessage({ client, outbox, kind, chatId, body: { ...body, text: finalText } });
    }

    clearInterval(typingInterval);
    return { ...result, onProgress: wrappedOnProgress };
  } catch (err: any) {
    clearInterval(typingInterval);
    if (placeholderMessageId) {
      // Error displayed via placeholder edit — do not rethrow to prevent duplicate error message
      try {
        const errorBody: any = {
          chat_id: chatId,
          message_id: placeholderMessageId,
          ...rest,
          text: `❌ ${err.message?.slice(0, 4000) || String(err)}`,
        };
        await client.editMessageText(errorBody);
      } catch {
        /* ignore edit failure */
      }
      console.error(`[${kind}] execution error`, err);
      return null;
    }
    throw err;
  }
}
