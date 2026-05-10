import fs from "node:fs/promises";
import path from "node:path";

export class TelegramClient {
  constructor(token, fetchImpl = fetch) {
    this.token = token;
    this.fetch = fetchImpl;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.lockHandle = null;
    this.lockPath = null;
  }

  async acquireLease(lockPath) {
    // Ensure the parent directory exists (fix: .data/ may not exist on fresh installs).
    await fs.mkdir(path.dirname(lockPath), { recursive: true });

    try {
      this.lockHandle = await fs.open(lockPath, "wx");
      this.lockPath = lockPath;
      await this.lockHandle.writeFile(String(process.pid));
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;

      // Lock file exists — check whether it belongs to a dead process (stale).
      let pid;
      try {
        const content = await fs.readFile(lockPath, "utf-8");
        pid = Number.parseInt(content.trim(), 10);
      } catch (readError) {
        // File vanished between EEXIST and readFile — another process cleaned it up; retry.
        if (readError.code === "ENOENT") return this.acquireLease(lockPath);
        throw readError;
      }

      if (!Number.isFinite(pid)) {
        throw new Error(`Polling already locked by another process (lock file exists: ${lockPath})`);
      }

      try {
        process.kill(pid, 0); // Throws ESRCH if process is gone, EPERM if alive but not ours
        throw new Error(`Polling already locked by an active process (PID: ${pid}, lock file: ${lockPath})`);
      } catch (killError) {
        if (killError.code !== "ESRCH") throw killError;
      }

      // Process is dead — remove stale lock.  Another process might race us here
      // (TOCTTOU); if so we get ENOENT, which we treat as "lock is gone, retry".
      console.warn(`[telegram] removing stale lock for dead PID ${pid}`);
      try {
        await fs.unlink(lockPath);
      } catch (unlinkError) {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
        // Concurrent process already removed the stale lock — safe to retry.
      }
      return this.acquireLease(lockPath);
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
      entry = { messages: [], flushing: false };
      this.groups.set(groupId, entry);
    }

    entry.messages.push(message);
    entry.timer = setTimeout(() => {
      entry.flushing = true;
      const messages = [...entry.messages]; // snapshot before delete
      this.groups.delete(groupId);
      Promise.resolve(this.onFlush(groupId, messages)).catch((err) => {
        console.error("[MediaGroupBuffer] onFlush error", err);
      });
    }, this.timeoutMs);
  }
}
