import { describe, expect, it, vi } from "vitest";
import { sendTelegramMessage, sendMessageWithProgress } from "../src/messageDelivery.js";
import { extractThreadId } from "../src/bridge.js";
import type { TelegramClient } from "../src/telegram.js";
import type { CliResult } from "../src/types.js";

const createMockClient = () => ({
  token: "t",
  fetch: vi.fn(),
  baseUrl: "b",
  call: vi.fn(),
  getUpdates: vi.fn(),
  sendMessage: vi.fn(async (body: any) => ({ ok: true, result: { message_id: 456, ...body } })),
  sendChatAction: vi.fn(async () => ({ ok: true, result: true })),
  editMessageText: vi.fn(async () => ({ ok: true, result: true })),
  sendMessageDraft: vi.fn(async () => ({ ok: true })),
  answerCallbackQuery: vi.fn(),
} as any as TelegramClient);

describe("extractThreadId", () => {
  it("returns thread id from the first message", () => {
    expect(extractThreadId([
      { message_id: 1, chat: { id: 1, type: "supergroup" }, message_thread_id: 42 },
      { message_id: 2, chat: { id: 1, type: "supergroup" }, message_thread_id: 42 },
    ])).toBe(42);
  });

  it("uses messages[0] even when a later message has text/caption", () => {
    expect(extractThreadId([
      { message_id: 1, chat: { id: 1, type: "supergroup" }, message_thread_id: 99 },
      { message_id: 2, chat: { id: 1, type: "supergroup" }, message_thread_id: 99, caption: "photo" },
    ])).toBe(99);
  });

  it("returns undefined when no message carries a thread id", () => {
    expect(extractThreadId([
      { message_id: 1, chat: { id: 1, type: "private" } },
    ])).toBeUndefined();
  });

  it("returns undefined for an empty array", () => {
    expect(extractThreadId([])).toBeUndefined();
  });
});

describe("Forum Topic Routing", () => {
  it("passes message_thread_id to sendMessage", async () => {
    const client = createMockClient();
    const chatId = 123;
    const threadId = 789;
    const body = { text: "Hello forum", message_thread_id: threadId };

    await sendTelegramMessage({ client, kind: "antigravity", chatId, body });

    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: chatId,
        message_thread_id: threadId,
        text: "Hello forum",
      })
    );
  });

  it("passes message_thread_id to sendMessageWithProgress and final send", async () => {
    const client = createMockClient();
    const chatId = 123;
    const threadId = 789;
    const execution = Promise.resolve({ text: "Final forum response", sessionId: "s1" } as CliResult);

    await sendMessageWithProgress({
      client,
      kind: "antigravity",
      chatId,
      execution,
      body: { message_thread_id: threadId }
    });

    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: chatId,
        message_thread_id: threadId,
      })
    );

    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: chatId,
        message_thread_id: threadId,
        text: "Final forum response",
      })
    );
  });
});
