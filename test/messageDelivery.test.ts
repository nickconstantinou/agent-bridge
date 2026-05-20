import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
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
  it("does not send a thinking placeholder for codex", async () => {
    const client = createMockClient();
    const chatId = 123;
    const execution = Promise.resolve({ text: "Final answer", sessionId: "s1" } as CliResult);

    await sendMessageWithProgress({ client, kind: "codex", chatId, execution });

    expect(client.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ chat_id: chatId, text: "🤔 Thinking..." })
    );
  });

  it("does not send a thinking placeholder for antigravity", async () => {
    const client = createMockClient();
    const chatId = 123;
    const execution = Promise.resolve({ text: "Final answer", sessionId: "s1" } as CliResult);

    await sendMessageWithProgress({ client, kind: "antigravity", chatId, execution });

    expect(client.sendMessage).not.toHaveBeenCalledWith(
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

    await sendMessageWithProgress({ client, kind: "antigravity", chatId, execution });

    expect(execution).toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalled();
  });

  it("slices final edit text to MAX_TELEGRAM_TEXT to prevent MESSAGE_TOO_LONG on editMessageText", async () => {
    const client = {
      sendMessage: vi.fn(async (body: any) => ({ ok: true, result: { message_id: 1, ...body } })),
      sendChatAction: vi.fn(async () => ({ ok: true })),
      editMessageText: vi.fn(async () => ({ ok: true })),
      sendMessageDraft: vi.fn(async () => ({ ok: true })),
    } as any as TelegramClient;
    const longText = "z".repeat(8000);

    await sendMessageWithProgress({
      client,
      kind: "codex",
      chatId: 123,
      execution: Promise.resolve({ text: longText, sessionId: null }),
    });

    expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.any(String) }));
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
      execution: (onProgress: (chunk: string) => void) => {
        onProgress(bigChunk);
        return Promise.resolve({ text: "done", sessionId: null });
      },
    });

    for (const editText of edits) {
      expect(editText.length).toBeLessThanOrEqual(4096);
    }
  });

  it("sends final error without a thinking placeholder for antigravity", async () => {
    const client = createMockClient();
    const chatId = 123;
    const execution = Promise.reject(new Error("CLI failed"));

    await expect(sendMessageWithProgress({ client, kind: "antigravity", chatId, execution })).resolves.toBeNull();

    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("❌ CLI failed") })
    );
    expect(client.editMessageText).not.toHaveBeenCalled();
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
      execution: (onProgress: (chunk: string) => void) => {
        onProgress("streaming chunk");
        return Promise.resolve({ text: "done", sessionId: null });
      },
    });

    expect(client.sendMessageDraft).not.toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ chat_id: chatId, text: "done" }));
  });

  it("filters Codex JSON progress events out of streamed previews", async () => {
    const client = createMockClient();
    const chatId = 123;

    await sendMessageWithProgress({
      client,
      kind: "codex",
      chatId,
      execution: (onProgress: (chunk: string) => void) => {
        onProgress('{"type":"thread.started","thread_id":"019e2159-b93a-7572-9067-c78a08615db7"}\n');
        onProgress('{"type":"response.output_text.delta","delta":"Hello there"}\n');
        return Promise.resolve({ text: "Hello there", sessionId: null });
      },
    });

    expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "Hello there" }));
    expect(client.editMessageText).not.toHaveBeenCalled();
  });

  it("debounces editMessageText for DM chats — only fires immediately when >= 1500ms elapsed", async () => {
    const client = {
      sendMessage: vi.fn(async (body: any) => ({ ok: true, result: { message_id: 1, ...body } })),
      sendChatAction: vi.fn(async () => ({ ok: true })),
      editMessageText: vi.fn(async () => ({ ok: true })),
      sendMessageDraft: vi.fn(async () => ({ ok: true })),
    } as any as TelegramClient;

    await sendMessageWithProgress({
      client,
      kind: "codex",
      chatId: 123,
      execution: (onProgress: (chunk: string) => void) => {
        // Three rapid chunks — only the first should fire immediately (lastSendTime=0)
        onProgress("a");
        onProgress("b");
        onProgress("c");
        return Promise.resolve({ text: "final", sessionId: null });
      },
    });

    expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "final" }));
  });
});

describe("dead code removed from messageDelivery.ts", () => {
  it("usePlaceholder, StreamingUpdater, and activeStreams are not present", () => {
    const src = readFileSync("src/messageDelivery.ts", "utf-8");
    expect(src).not.toContain("usePlaceholder");
    expect(src).not.toContain("StreamingUpdater");
    expect(src).not.toContain("activeStreams");
  });
});

describe("isAborted suppression", () => {
  it("suppresses final sendTelegramMessage when isAborted() returns true", async () => {
    const client = createMockClient();
    await sendMessageWithProgress({
      client,
      kind: "codex",
      chatId: 123,
      execution: Promise.resolve({ text: "partial", sessionId: null }),
      isAborted: () => true,
    });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});
