import { splitTelegramText, escapeTelegramMarkdownV2, toTelegramEntitiesText } from "./render.js";

export async function sendTelegramMessage({ client, outbox, kind, chatId, body }) {
  const chunks = splitTelegramText(String(body.text || ""));
  const { text: _ignored, ...rest } = body;
  const isGemini = kind === "gemini";

  for (let i = 0; i < chunks.length; i += 1) {
    const chunkText = chunks[i];
    const chunkBody = {
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
      await outbox.send(chatId, chunkBody, (message) => client.sendMessage(message));
      continue;
    }

    try {
      await outbox.send(chatId, chunkBody, (message) => client.sendMessage(message));
    } catch (error) {
      try {
        console.warn(`[${kind}] Raw MarkdownV2 failed, trying escaped`, error.message);
        const escapedBody = { ...chunkBody, text: escapeTelegramMarkdownV2(chunks[i]) };
        await outbox.send(chatId, escapedBody, (message) => client.sendMessage(message));
      } catch (escapeError) {
        console.warn(`[${kind}] Escaped MarkdownV2 failed, falling back to plain text`, escapeError.message);
        const plainBody = { ...chunkBody, text: chunks[i] };
        delete plainBody.parse_mode;
        await outbox.send(chatId, plainBody, (message) => client.sendMessage(message));
      }
    }
  }
}

/**
 * Send a message with progress streaming.
 * Sends initial placeholder, streams updates via editMessageText, replaces on final.
 * @param options - Configuration object
 * @param options.client - Telegram client
 * @param options.outbox - Outbox for rate limiting
 * @param options.kind - Bot kind (gemini/codex)
 * @param options.chatId - Chat ID
 * @param options.execution - Promise resolving to CLI result
 * @param options.placeholderText - Initial placeholder text
 * @param options.onProgress - Callback for progress updates
 * @param options.body - Optional additional fields (like message_thread_id)
 */
export async function sendMessageWithProgress({ client, outbox, kind, chatId, execution, placeholderText = "🤔 Thinking...", onProgress = () => {}, body = {} }) {
  const isGemini = kind === "gemini";
  const { text: _ignored, ...rest } = body;

  const sendTyping = async () => {
    try {
      await outbox.send(chatId, { chat_id: chatId, ...rest, action: "typing" }, (msg) => client.sendChatAction(msg));
    } catch { /* ignore */ }
  };


  // 1. Send typing indicator
  await sendTyping();
  let typingInterval = setInterval(sendTyping, 4500);


  // 2. Send placeholder message
  const placeholderBody = {
    chat_id: chatId,
    ...rest,
    text: placeholderText,
  };
  let placeholderMsg;
  try {
    placeholderMsg = await outbox.send(chatId, placeholderBody, (msg) => client.sendMessage(msg));
  } catch (err) {
    clearInterval(typingInterval);
    throw err;
  }

  const placeholderMessageId = placeholderMsg?.result?.message_id;

  let lastUpdateMs = Date.now();
  let currentText = "";
  const UPDATE_INTERVAL_MS = 2000;

  const flushProgress = async (text, isFinal = false) => {
    currentText = text;
    const now = Date.now();
    if (!isFinal && now - lastUpdateMs < UPDATE_INTERVAL_MS) return;
    if (!placeholderMessageId) return;

    lastUpdateMs = now;
    try {
      await client.editMessageText({
        chat_id: chatId,
        message_id: placeholderMessageId,
        ...rest,
        text: currentText || "...",
      });
    } catch (err) {
      console.warn(`[${kind}] progress edit failed`, err.message);
    }
  };

  // Wrap onProgress to flush to Telegram
  const originalOnProgress = onProgress;
  const wrappedOnProgress = (chunk) => {
    const newText = (currentText || "") + chunk;
    void flushProgress(newText, false);
    originalOnProgress?.(chunk);
  };

  try {
    // 3. Wait for execution, streaming progress
    // Note: The caller must pass a promise that accepts onProgress or use a custom mechanism.
    // In our case, the caller in index.js handles the CLI progress.
    // We need to re-expose our wrappedOnProgress.
    
    // IF the execution is a function that takes onProgress, call it.
    // Otherwise, assume the caller will call our onProgress.
    let result;
    if (typeof execution === "function") {
      result = await execution(wrappedOnProgress);
    } else {
      result = await execution;
    }
    
    const finalText = result?.text || currentText || "";

    // 4. Replace placeholder with final result
    if (placeholderMessageId) {
      try {
        await client.editMessageText({
          chat_id: chatId,
          message_id: placeholderMessageId,
          ...rest,
          text: finalText,
        });
      } catch (editErr) {
        // Fallback: send new message if edit fails
        console.warn(`[${kind}] final edit failed, sending new message`, editErr.message);
        await sendTelegramMessage({ client, outbox, kind, chatId, body: { ...body, text: finalText } });
      }
    } else {
      // No placeholder, send fresh
      await sendTelegramMessage({ client, outbox, kind, chatId, body: { ...body, text: finalText } });
    }

    clearInterval(typingInterval);
    return { ...result, onProgress: wrappedOnProgress };
  } catch (err) {
    clearInterval(typingInterval);
    // On error, try to edit placeholder with error message
    if (placeholderMessageId) {
      try {
        await client.editMessageText({
          chat_id: chatId,
          message_id: placeholderMessageId,
          ...rest,
          text: `❌ ${err.message?.slice(0, 4000) || String(err)}`,
        });
      } catch { /* ignore edit failure */ }
    }
    throw err;
  }
}
