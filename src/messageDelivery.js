import { splitTelegramText, escapeTelegramMarkdownV2 } from "./render.js";

export async function sendTelegramMessage({ client, outbox, kind, chatId, body }) {
  const chunks = splitTelegramText(String(body.text || ""));
  const { text: _ignored, ...rest } = body;

  for (let i = 0; i < chunks.length; i += 1) {
    const chunkBody = {
      chat_id: chatId,
      ...rest,
      text: chunks[i],
      parse_mode: "MarkdownV2",
    };

    if (i > 0) delete chunkBody.reply_markup;

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
