import { describe, expect, it } from "vitest";
import { TelegramClient } from "../src/telegram.js";

describe("TelegramClient", () => {
  it("preserves retry_after metadata on 429 errors", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 429,
      json: async () => ({ ok: false, description: "Too Many Requests", parameters: { retry_after: 0.1 } }),
    })) as any;

    const client = new TelegramClient("token", fakeFetch);

    await expect(client.sendMessage({ chat_id: 1, text: "hi" })).rejects.toMatchObject({
      status: 429,
      retryAfter: 0.1,
    });
  });

  it("automatically retries on 429 errors if retry_after is provided", async () => {
    let callCount = 0;
    const fakeFetch = (async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 429,
          json: async () => ({ ok: false, description: "Too Many Requests", parameters: { retry_after: 1 } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 123 } }),
      };
    }) as any;

    const client = new TelegramClient("token", fakeFetch);
    const start = Date.now();
    const result = await client.sendMessage({ chat_id: 1, text: "hi" });
    const duration = Date.now() - start;

    expect(callCount).toBe(2);
    expect(result.ok).toBe(true);
    expect(duration).toBeGreaterThanOrEqual(1000);
  });

  it("keeps the Telegram description text on non-429 errors", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: "Bad Request: chat not found" }),
    })) as any;

    const client = new TelegramClient("token", fakeFetch);

    await expect(client.sendMessage({ chat_id: 1, text: "hi" })).rejects.toThrow(/chat not found/);
  });

  it("aborts fetch after fetchTimeoutMs and rejects with AbortError", async () => {
    const fakeFetch = ((_url: string, options: any) =>
      new Promise((_, reject) => {
        options.signal.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted", "AbortError"))
        );
      })
    ) as any;
    const client = new TelegramClient("token", fakeFetch, 50);
    await expect(client.sendMessage({ chat_id: 1, text: "hi" })).rejects.toThrow("aborted");
  }, 2000);

  it("supports chat actions for typing indicators", async () => {
    const calls: any[] = [];
    const fakeFetch = (async (url: string, options: any) => {
      calls.push({ url, options: JSON.parse(options.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: true }),
      };
    }) as any;

    const client = new TelegramClient("token", fakeFetch);

    await client.sendChatAction({ chat_id: 1, action: "typing" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/sendChatAction");
    expect(calls[0].options).toEqual({ chat_id: 1, action: "typing" });
  });
});
