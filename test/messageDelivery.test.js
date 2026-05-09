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

  it("sends gemini messages as entities", async () => {
    const calls = [];
    const client = {
      async sendMessage(message) {
        calls.push(message);
        return { ok: true };
      },
    };
    const outbox = { async send(_chatId, message, sendFn) { return sendFn(message); } };

    await sendTelegramMessage({ client, outbox, kind: "gemini", chatId: 1, body: { text: "**Hello** and `code`" } });

    expect(calls[0].parse_mode).toBeUndefined();
    expect(calls[0].entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "bold" }),
        expect.objectContaining({ type: "code" }),
      ]),
    );
  });
});
