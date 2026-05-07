export class TelegramClient {
  constructor(token, fetchImpl = fetch) {
    this.token = token;
    this.fetch = fetchImpl;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async call(method, body = {}) {
    const payload = { ...body };
    if (payload.reply_markup && typeof payload.reply_markup === "object") {
      payload.reply_markup = JSON.stringify(payload.reply_markup);
    }

    const response = await this.fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const detail = data?.description ? `: ${data.description}` : "";
      const error = new Error(`Telegram HTTP ${response.status}${detail}`);
      error.status = response.status;
      error.data = data;
      error.retryAfter = data?.parameters?.retry_after ?? data?.retry_after ?? null;
      throw error;
    }

    if (!data.ok) {
      throw new Error(data.description || `Telegram ${method} failed`);
    }
    return data;
  }

  async getUpdates(options) {
    return this.call("getUpdates", options);
  }

  async sendMessage(body) {
    return this.call("sendMessage", body);
  }

  async answerCallbackQuery(body) {
    return this.call("answerCallbackQuery", body);
  }

  async editMessageText(body) {
    return this.call("editMessageText", body);
  }
}
