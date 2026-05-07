import { describe, expect, it } from "vitest";
import { TelegramClient } from "../src/telegram.js";

describe("TelegramClient", () => {
  it("preserves retry_after metadata on 429 errors", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 429,
      json: async () => ({ ok: false, description: "Too Many Requests", parameters: { retry_after: 2 } }),
    });

    const client = new TelegramClient("token", fakeFetch);

    await expect(client.sendMessage({ chat_id: 1, text: "hi" })).rejects.toMatchObject({
      status: 429,
      retryAfter: 2,
    });
  });
});
