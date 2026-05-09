import { describe, expect, it } from "vitest";
import { sendTelegramMessage } from "../src/messageDelivery.js";

describe("message delivery", () => {
  it("uses raw MarkdownV2 when it succeeds", async () => {
    const calls = [];
    const client = {
      async sendMessage(message) {
        calls.push(message);
        return { ok: true };
      },
    };
    const outbox = { async send(_chatId, message, sendFn) { return sendFn(message); } };

    await sendTelegramMessage({ client, outbox, kind: "codex", chatId: 1, body: { text: "hello *world*" } });

    expect(calls[0].parse_mode).toBe("MarkdownV2");
  });

  it("sends gemini messages as HTML", async () => {
    const calls = [];
    const client = {
      async sendMessage(message) {
        calls.push(message);
        return { ok: true };
      },
    };
    const outbox = { async send(_chatId, message, sendFn) { return sendFn(message); } };

    await sendTelegramMessage({ client, outbox, kind: "gemini", chatId: 1, body: { text: '<b>Hello</b> & "world"' } });

    expect(calls[0].parse_mode).toBe("HTML");
    expect(calls[0].text).toBe("&lt;b&gt;Hello&lt;/b&gt; &amp; &quot;world&quot;");
  });
});
