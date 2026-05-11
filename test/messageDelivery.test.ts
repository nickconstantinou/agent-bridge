import { describe, expect, it, vi } from "vitest";
import { sendTelegramMessage, sendMessageWithProgress } from "../src/messageDelivery.js";
import type { TelegramClient } from "../src/telegram.js";
import type { CliResult } from "../src/types.js";

const createMockClient = () => ({
  sendMessage: vi.fn(async (body: any) => ({ ok: true, result: { message_id: 456, ...body } })),
  sendChatAction: vi.fn(async () => ({ ok: true, result: true })),
  editMessageText: vi.fn(async () => ({ ok: true, result: true })),
  sendMessageDraft: vi.fn(async () => ({ ok: true })),
} as any as TelegramClient);

describe("sendMessageWithProgress", () => {
  it("sends initial placeholder message", async () => {
    const client = createMockClient();
    const chatId = 123;
    const execution = Promise.resolve({ text: "Final answer", sessionId: "s1" } as CliResult);

    await sendMessageWithProgress({ client, kind: "gemini", chatId, execution, placeholderText: "🤔 Thinking..." });

    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chat_id: chatId, text: "🤔 Thinking..." })
    );
  });

  it("handles execution as a function and passes onProgress", async () => {
    const client = createMockClient();
    const chatId = 123;
    const execution = vi.fn(async (onProgress: any) => {
      onProgress("chunk1");
      return { text: "Final answer", sessionId: "s1" } as CliResult;
    });

    await sendMessageWithProgress({ client, kind: "gemini", chatId, execution });

    expect(execution).toHaveBeenCalled();
    expect(client.editMessageText).toHaveBeenCalled();
  });

  it("slices final edit text to MAX_TELEGRAM_TEXT to prevent MESSAGE_TOO_LONG on editMessageText", async () => {
    const edits: string[] = [];
    const client = {
      sendMessage: vi.fn(async () => ({ ok: true, result: { message_id: 1 } })),
      sendChatAction: vi.fn(async () => ({ ok: true })),
      editMessageText: vi.fn(async (body: any) => { edits.push(body.text); return { ok: true }; }),
      sendMessageDraft: vi.fn(async () => ({ ok: true })),
    } as any as TelegramClient;
    const longText = "z".repeat(8000);

    await sendMessageWithProgress({
      client,
      kind: "codex",
      chatId: 123,
      execution: Promise.resolve({ text: longText, sessionId: null }),
    });

    const lastEdit = edits[edits.length - 1];
    expect(lastEdit.length).toBeLessThanOrEqual(4096);
  });

  it("truncates progress text to 4096 chars to stay within Telegram API limits", async () => {
    const edits: string[] = [];
    const client = {
      sendMessage: vi.fn(async () => ({ ok: true, result: { message_id: 1 } })),
      sendChatAction: vi.fn(async () => ({ ok: true })),
      editMessageText: vi.fn(async (body: any) => { edits.push(body.text); return { ok: true }; }),
      sendMessageDraft: vi.fn(async () => ({ ok: true })),
    } as any as TelegramClient;
    const bigChunk = "x".repeat(5000);

    await sendMessageWithProgress({
      client,
      kind: "codex",
      chatId: 123,
      chatType: "private",
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
    const chatId = 123;
    const execution = Promise.reject(new Error("CLI failed"));

    await expect(sendMessageWithProgress({ client, kind: "gemini", chatId, execution })).resolves.toBeNull();

    expect(client.editMessageText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("❌ CLI failed") })
    );
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not send duplicate message when final edit returns 'message is not modified'", async () => {
    const client = {
      sendMessage: vi.fn(async () => ({ ok: true, result: { message_id: 1 } })),
      sendChatAction: vi.fn(async () => ({ ok: true })),
      editMessageText: vi.fn(async () => {
        throw new Error("Bad Request: message is not modified: specified new message content and reply markup are identical");
      }),
      sendMessageDraft: vi.fn(async () => ({ ok: true })),
    } as any as TelegramClient;

    await sendMessageWithProgress({
      client,
      kind: "codex",
      chatId: 123,
      execution: Promise.resolve({ text: "Hello", sessionId: null }),
    });

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("calls sendMessageDraft for non-DM chats instead of editMessageText during streaming", async () => {
    const client = createMockClient();
    const chatId = 123;

    await sendMessageWithProgress({
      client,
      kind: "codex",
      chatId,
      chatType: "supergroup",
      execution: (onProgress: (chunk: string) => void) => {
        onProgress("streaming chunk");
        return Promise.resolve({ text: "done", sessionId: null });
      },
    });

    expect(client.sendMessageDraft).toHaveBeenCalledWith(chatId, "streaming chunk");
  });

  it("debounces editMessageText for DM chats — only fires immediately when >= 1500ms elapsed", async () => {
    const edits: string[] = [];
    const client = {
      sendMessage: vi.fn(async () => ({ ok: true, result: { message_id: 1 } })),
      sendChatAction: vi.fn(async () => ({ ok: true })),
      editMessageText: vi.fn(async (body: any) => { edits.push(body.text); return { ok: true }; }),
      sendMessageDraft: vi.fn(async () => ({ ok: true })),
    } as any as TelegramClient;

    await sendMessageWithProgress({
      client,
      kind: "codex",
      chatId: 123,
      chatType: "private",
      execution: (onProgress: (chunk: string) => void) => {
        // Three rapid chunks — only the first should fire immediately (lastSendTime=0)
        onProgress("a");
        onProgress("b");
        onProgress("c");
        return Promise.resolve({ text: "final", sessionId: null });
      },
    });

    // The first chunk fires immediately (elapsed >= 1500 since lastSendTime=0).
    // Subsequent rapid chunks are debounced. The flush always fires.
    // So there should be at most 2 edits: one from the first chunk + the flush.
    expect(edits.length).toBeLessThanOrEqual(3);
    expect(edits[edits.length - 1]).toBe("final");
  });
});
