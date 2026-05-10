import { describe, expect, it, vi } from "vitest";
import { sendTelegramMessage, sendMessageWithProgress } from "../src/messageDelivery.js";

const createMockClient = () => ({
  sendMessage: vi.fn(async (body) => ({ ok: true, result: { message_id: 456, ...body } })),
});

const createMockOutbox = () => ({
  send: vi.fn(async (chatId, body, fn) => {
    return fn({ chat_id: chatId, ...body });
  }),
});

describe("Forum Topic Routing", () => {
  it("passes message_thread_id to sendMessage", async () => {
    const client = createMockClient();
    const outbox = createMockOutbox();
    const chatId = 123;
    const threadId = 789;
    const body = { text: "Hello forum", message_thread_id: threadId };

    await sendTelegramMessage({ client, outbox, kind: "gemini", chatId, body });

    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: chatId,
        message_thread_id: threadId,
        text: "Hello forum",
      })
    );
  });

  it("passes message_thread_id to sendMessageWithProgress and editMessageText", async () => {
    const client = {
      sendMessage: vi.fn(async (body) => ({ ok: true, result: { message_id: 456, ...body } })),
      sendChatAction: vi.fn(async () => ({ ok: true, result: true })),
      editMessageText: vi.fn(async () => ({ ok: true, result: true })),
    };
    const outbox = createMockOutbox();
    const chatId = 123;
    const threadId = 789;
    const execution = Promise.resolve({ text: "Final forum response" });

    await sendMessageWithProgress({
      client,
      outbox,
      kind: "gemini",
      chatId,
      execution,
      body: { message_thread_id: threadId } // Pass it in body
    });

    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: chatId,
        message_thread_id: threadId,
      })
    );

    expect(client.editMessageText).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: chatId,
        message_thread_id: threadId,
        text: "Final forum response",
      })
    );
  });
});
