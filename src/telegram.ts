import type { TelegramMessage } from "./types.js";

export interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
  parameters?: {
    retry_after?: number;
  };
  retry_after?: number;
}

export class TelegramClient {
  private readonly token: string;
  fetch: typeof fetch;
  baseUrl: string;
  private readonly fetchTimeoutMs: number;

  constructor(token: string, fetchImpl = fetch, fetchTimeoutMs = 45_000) {
    this.token = token;
    this.fetch = fetchImpl;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.fetchTimeoutMs = fetchTimeoutMs;
  }

  async call<T>(method: string, body: any = {}, retryCount = 0): Promise<TelegramResponse<T>> {
    const payload = { ...body };
    if (payload.reply_markup && typeof payload.reply_markup === "object") {
      payload.reply_markup = JSON.stringify(payload.reply_markup);
    }

    const ac = new AbortController();
    const fetchTimer = setTimeout(() => ac.abort(), this.fetchTimeoutMs);
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(fetchTimer);
    }

    let data: any = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const detail = data?.description ? `: ${data.description}` : "";
      const error = new Error(`Telegram HTTP ${response.status}${detail}`) as any;
      error.status = response.status;
      error.data = data;
      error.retryAfter = data?.parameters?.retry_after ?? data?.retry_after ?? null;

      if (error.status === 429 && error.retryAfter && retryCount < 2) {
        console.warn(`[telegram] rate limited, retrying after ${error.retryAfter}s (attempt ${retryCount + 1})`);
        await new Promise((resolve) => setTimeout(resolve, error.retryAfter * 1000));
        return this.call(method, body, retryCount + 1);
      }

      throw error;
    }

    if (!data.ok) {
      throw new Error(data.description || `Telegram ${method} failed`);
    }
    return data;
  }

  async getUpdates(options: any): Promise<TelegramResponse<any[]>> {
    return this.call("getUpdates", options);
  }

  async sendMessage(body: any): Promise<TelegramResponse<TelegramMessage>> {
    return this.call("sendMessage", body);
  }

  async answerCallbackQuery(body: any): Promise<TelegramResponse<boolean>> {
    return this.call("answerCallbackQuery", body);
  }

  async editMessageText(body: any): Promise<TelegramResponse<TelegramMessage>> {
    return this.call("editMessageText", body);
  }

  async sendChatAction(body: any): Promise<TelegramResponse<boolean>> {
    return this.call("sendChatAction", body);
  }

}

type FlushFn = (groupId: string | null, messages: TelegramMessage[]) => void | Promise<void>;

interface BufferEntry {
  timer: NodeJS.Timeout | undefined;
  messages: TelegramMessage[];
  flushing: boolean;
}

export class MediaGroupBuffer {
  timeoutMs: number;
  onFlush: FlushFn;
  groups: Map<string, BufferEntry>;

  constructor({ timeoutMs = 1500, onFlush }: { timeoutMs?: number; onFlush: FlushFn }) {
    this.timeoutMs = timeoutMs;
    this.onFlush = onFlush;
    this.groups = new Map();
  }

  push(message: TelegramMessage): void {
    const groupId = message.media_group_id;
    if (!groupId) {
      Promise.resolve(this.onFlush(null, [message])).catch((err) => {
        console.error("[MediaGroupBuffer] onFlush error", err);
      });
      return;
    }

    let entry = this.groups.get(groupId);
    // If the entry is already being flushed, start a fresh one for new messages.
    if (entry && !entry.flushing) {
      clearTimeout(entry.timer);
    } else {
      entry = { timer: undefined, messages: [], flushing: false };
      this.groups.set(groupId, entry);
    }

    entry.messages.push(message);
    entry.timer = setTimeout(() => {
      entry!.flushing = true;
      const messages = [...entry!.messages]; // snapshot before delete
      this.groups.delete(groupId);
      Promise.resolve(this.onFlush(groupId, messages)).catch((err) => {
        console.error("[MediaGroupBuffer] onFlush error", err);
      });
    }, this.timeoutMs);
  }
}
