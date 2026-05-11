import { describe, expect, it, vi } from "vitest";
import { sendTelegramMessage, sendMessageWithProgress } from "../src/messageDelivery.js";
import type { TelegramClient } from "../src/telegram.js";
import type { CliResult } from "../src/types.js";

const createMockClient = () => ({
  sendMessage: vi.fn(async (body: any) => ({ ok: true, result: { message_id: 456, ...body } })),
  sendChatAction: vi.fn(async () => ({ ok: true, result: true })),
  editMessageText: vi.fn(async () => ({ ok: true, result: true })),
} as any as TelegramClient);

const createMockOutbox = () => ({
  send: vi.fn(async (chatId: number, body: any, fn: (msg: any) => Promise<any>) => {
    const msg = { chat_id: chatId, ...body };
    return fn(msg);
  }),
});

describe("sendMessageWithProgress", () => {
  it("sends initial placeholder message", async () => {
    const client = createMockClient();
    const outbox = createMockOutbox();
    const chatId = 123;
    const execution = Promise.resolve({ text: "Final answer", sessionId: "s1" } as CliResult);

    await sendMessageWithProgress({
      client,
      outbox,
      kind: "gemini",
      chatId,
      execution,
      placeholderText: "🤔 Thinking...",
    });

    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: chatId,
        text: "🤔 Thinking...",
      })
    );
  });

  it("handles execution as a function and passes onProgress", async () => {
    const client = createMockClient();
    const outbox = createMockOutbox();
    const chatId = 123;
    const execution = vi.fn(async (onProgress: any) => {
        onProgress("chunk1");
        return { text: "Final answer", sessionId: "s1" } as CliResult;
    });

    await sendMessageWithProgress({
      client,
      outbox,
      kind: "gemini",
      chatId,
      execution,
    });

    expect(execution).toHaveBeenCalled();
    expect(client.editMessageText).toHaveBeenCalled();
  });

  it("slices final edit text to MAX_TELEGRAM_TEXT to prevent MESSAGE_TOO_LONG on editMessageText", async () => {
    const edits: string[] = [];
    const client = {
      sendMessage: vi.fn(async () => ({ ok: true, result: { message_id: 1 } })),
      sendChatAction: vi.fn(async () => ({ ok: true })),
      editMessageText: vi.fn(async (body: any) => {
        edits.push(body.text);
        return { ok: true };
      }),
    } as any as TelegramClient;
    const outbox = createMockOutbox();
    const longText = "z".repeat(8000);

    await sendMessageWithProgress({
      client,
      outbox,
      kind: "codex",
      chatId: 123,
      execution: Promise.resolve({ text: longText, sessionId: null }),
    });

    // The final edit (last editMessageText call) must not exceed 4096 chars
    const lastEdit = edits[edits.length - 1];
    expect(lastEdit.length).toBeLessThanOrEqual(4096);
  });

  it("truncates progress text to 4096 chars to stay within Telegram API limits", async () => {
    const edits: string[] = [];
    const client = {
      sendMessage: vi.fn(async () => ({ ok: true, result: { message_id: 1 } })),
      sendChatAction: vi.fn(async () => ({ ok: true })),
      editMessageText: vi.fn(async (body: any) => {
        edits.push(body.text);
        return { ok: true };
      }),
    } as any as TelegramClient;
    const outbox = createMockOutbox();
    const bigChunk = "x".repeat(5000);

    await sendMessageWithProgress({
      client,
      outbox,
      kind: "codex",
      chatId: 123,
      execution: (onProgress: (chunk: string) => void) => {
        onProgress(bigChunk);
        return Promise.resolve({ text: "done", sessionId: null });
      },
    });

    for (const editText of edits) {
      expect(editText.length).toBeLessThanOrEqual(4096);
    }
  });

  it("edits placeholder with error and does not rethrow (prevents duplicate message)", async () => {
    const client = createMockClient();
    const outbox = createMockOutbox();
    const chatId = 123;
    const execution = Promise.reject(new Error("CLI failed"));

    // Should resolve (not throw) so the caller does not send a second error message
    await expect(sendMessageWithProgress({
      client,
      outbox,
      kind: "gemini",
      chatId,
      execution,
    })).resolves.toBeNull();

    // Error shown via placeholder edit
    expect(client.editMessageText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("❌ CLI failed"),
      })
    );
    // Only one sendMessage call (the placeholder) — no second error message
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });
});
