import { splitTelegramText, escapeTelegramMarkdownV2, toTelegramEntitiesText } from "./render.js";
import type { TelegramClient } from "./telegram.js";
import type { CliResult } from "./types.js";

const MAX_TELEGRAM_TEXT = 4096;
const DEBOUNCE_MS = 1500;

interface StreamEntry {
  updateTimer: NodeJS.Timeout | null;
  lastText: string;
  lastSendTime: number;
}

const activeStreams = new Map<number, StreamEntry>();

function truncate(text: string): string {
  return text.length > MAX_TELEGRAM_TEXT ? text.slice(-MAX_TELEGRAM_TEXT) : text;
}

class StreamingUpdater {
  private readonly client: TelegramClient;
  private readonly chatId: number;
  private readonly messageId: number;
  private readonly isDm: boolean;
  private readonly isGemini: boolean;
  private readonly rest: Record<string, any>;
  private readonly kind: string;

  constructor({
    client,
    chatId,
    messageId,
    isDm,
    isGemini,
    rest,
    kind,
  }: {
    client: TelegramClient;
    chatId: number;
    messageId: number;
    isDm: boolean;
    isGemini: boolean;
    rest: Record<string, any>;
    kind: string;
  }) {
    this.client = client;
    this.chatId = chatId;
    this.messageId = messageId;
    this.isDm = isDm;
    this.isGemini = isGemini;
    this.rest = rest;
    this.kind = kind;
    activeStreams.set(chatId, { updateTimer: null, lastText: "", lastSendTime: 0 });
  }

  push(text: string): void {
    const entry = activeStreams.get(this.chatId);
    if (!entry) return;
    entry.lastText = text;

    if (!this.isDm) {
      // Group/channel: bypass debouncing, use draft transport
      const editText = truncate(text);
      const extra: Record<string, any> = {};
      if (this.isGemini) {
        const ep = toTelegramEntitiesText(editText);
        extra.text = ep.text;
        if (ep.entities.length > 0) extra.entities = ep.entities;
        void this.client.sendMessageDraft(this.chatId, ep.text, extra);
      } else {
        void this.client.sendMessageDraft(this.chatId, editText);
      }
      return;
    }

    // DM: debounce editMessageText to avoid rate limits
    const now = Date.now();
    const elapsed = now - entry.lastSendTime;

    if (elapsed >= DEBOUNCE_MS) {
      if (entry.updateTimer) {
        clearTimeout(entry.updateTimer);
        entry.updateTimer = null;
      }
      entry.lastSendTime = now;
      void this.doEdit(text);
    } else if (!entry.updateTimer) {
      const remaining = DEBOUNCE_MS - elapsed;
      entry.updateTimer = setTimeout(() => {
        const e = activeStreams.get(this.chatId);
        if (!e) return;
        e.updateTimer = null;
        e.lastSendTime = Date.now();
        void this.doEdit(e.lastText);
      }, remaining);
    }
    // else: timer already pending — it will read lastText when it fires
  }

  async flush(finalText: string): Promise<void> {
    const entry = activeStreams.get(this.chatId);
    if (entry?.updateTimer) {
      clearTimeout(entry.updateTimer);
    }
    activeStreams.delete(this.chatId);

    const editText = truncate(finalText || "...");
    const finalBody: any = {
      chat_id: this.chatId,
      message_id: this.messageId,
      ...this.rest,
      text: editText,
    };

    if (this.isGemini) {
      const ep = toTelegramEntitiesText(editText);
      finalBody.text = ep.text;
      if (ep.entities.length > 0) finalBody.entities = ep.entities;
    }

    await this.client.editMessageText(finalBody);
  }

  private async doEdit(text: string): Promise<void> {
    const editText = truncate(text || "...");
    const editBody: any = {
      chat_id: this.chatId,
      message_id: this.messageId,
      ...this.rest,
      text: editText,
    };
    if (this.isGemini) {
      const ep = toTelegramEntitiesText(editText);
      editBody.text = ep.text;
      if (ep.entities.length > 0) editBody.entities = ep.entities;
    }
    try {
      await this.client.editMessageText(editBody);
    } catch (err: any) {
      if (!err.message?.includes("message is not modified")) {
        console.warn(`[${this.kind}] stream edit failed`, err.message);
      }
    }
  }
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
  chatType = "private",
  execution,
  placeholderText = "🤔 Thinking...",
  onProgress = () => {},
  body = {},
}: {
  client: TelegramClient;
  kind: string;
  chatId: number;
  chatType?: string;
  execution: ((onProgress: (text: string) => void) => Promise<CliResult>) | Promise<CliResult>;
  placeholderText?: string;
  onProgress?: (text: string) => void;
  body?: any;
}): Promise<CliResult | null> {
  const isDm = chatType === "private";
  const isGemini = kind === "gemini";
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

  // Send placeholder
  let placeholderMsg: any;
  try {
    placeholderMsg = await client.sendMessage({ chat_id: chatId, ...rest, text: placeholderText });
  } catch (err) {
    clearInterval(typingInterval);
    throw err;
  }

  const placeholderMessageId = placeholderMsg?.result?.message_id;
  if (!placeholderMessageId) {
    clearInterval(typingInterval);
    throw new Error("sendMessage did not return a message_id");
  }

  const updater = new StreamingUpdater({ client, chatId, messageId: placeholderMessageId, isDm, isGemini, rest, kind });

  let currentText = "";
  const originalOnProgress = onProgress;
  const wrappedOnProgress = (chunk: string) => {
    currentText += chunk;
    updater.push(currentText);
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

    try {
      await updater.flush(finalText);
    } catch (editErr: any) {
      if (editErr.message?.includes("message is not modified")) {
        // Progress streaming already set this text — no-op
      } else {
        console.warn(`[${kind}] final edit failed, sending new message`, editErr.message);
        await sendTelegramMessage({ client, kind, chatId, body: { ...body, text: finalText } });
      }
    }

    clearInterval(typingInterval);
    return { ...result, onProgress: wrappedOnProgress };
  } catch (err: any) {
    clearInterval(typingInterval);
    // Show error in the placeholder edit so the user sees it without a duplicate message
    try {
      await client.editMessageText({
        chat_id: chatId,
        message_id: placeholderMessageId,
        ...rest,
        text: `❌ ${err.message?.slice(0, 4000) || String(err)}`,
      });
    } catch {
      /* ignore edit failure */
    }
    console.error(`[${kind}] execution error`, err);
    return null;
  }
}
