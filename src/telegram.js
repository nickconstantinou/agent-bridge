import fs from "node:fs/promises";

export class TelegramClient {
  constructor(token, fetchImpl = fetch) {
    this.token = token;
    this.fetch = fetchImpl;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.lockHandle = null;
    this.lockPath = null;
  }

  async acquireLease(lockPath) {
    try {
      this.lockHandle = await fs.open(lockPath, "wx");
      this.lockPath = lockPath;
      // Write PID to lock file for debugging
      await this.lockHandle.writeFile(String(process.pid));
      return true;
    } catch (error) {
      if (error.code === "EEXIST") {
        // Check if the lock is stale
        try {
          const content = await fs.readFile(lockPath, "utf-8");
          const pid = Number.parseInt(content.trim(), 10);
          if (Number.isFinite(pid)) {
            try {
              process.kill(pid, 0); // Throws if process is dead
              // If it doesn't throw, the process is alive.
              throw new Error(`Polling already locked by an active process (PID: ${pid}, lock file: ${lockPath})`);
            } catch (killError) {
              if (killError.code === "ESRCH") {
                // Process is dead, remove stale lock
                console.warn(`[telegram] removing stale lock for dead PID ${pid}`);
                await fs.unlink(lockPath);
                return this.acquireLease(lockPath);
              }
              throw killError;
            }
          }
        } catch (readError) {
          // If file was deleted between catch and read, just retry
          if (readError.code === "ENOENT") return this.acquireLease(lockPath);
          throw readError;
        }
        
        throw new Error(`Polling already locked by another process (lock file exists: ${lockPath})`);
      }
      throw error;
    }
  }

  async releaseLease() {
    if (this.lockHandle) {
      await this.lockHandle.close();
      this.lockHandle = null;
    }
    if (this.lockPath) {
      try {
        await fs.unlink(this.lockPath);
      } catch {
        // ignore
      }
      this.lockPath = null;
    }
  }

  async call(method, body = {}, retryCount = 0) {
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

  async sendChatAction(body) {
    return this.call("sendChatAction", body);
  }
}

export class MediaGroupBuffer {
  constructor({ timeoutMs = 1500, onFlush }) {
    this.timeoutMs = timeoutMs;
    this.onFlush = onFlush;
    this.groups = new Map();
  }

  push(message) {
    const groupId = message.media_group_id;
    if (!groupId) {
      this.onFlush(null, [message]);
      return;
    }

    let entry = this.groups.get(groupId);
    if (entry) {
      clearTimeout(entry.timer);
    } else {
      entry = { messages: [] };
      this.groups.set(groupId, entry);
    }

    entry.messages.push(message);
    entry.timer = setTimeout(() => {
      this.groups.delete(groupId);
      this.onFlush(groupId, entry.messages);
    }, this.timeoutMs);
  }
}
