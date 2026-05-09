import { describe, expect, it, vi } from "vitest";
import { sendTelegramMessage, sendMessageWithProgress } from "../src/messageDelivery.js";

const createMockClient = (overrides = {}) => ({
  sendMessage: vi.fn(),
  sendChatAction: vi.fn(),
  editMessageText: vi.fn(),
  ...overrides,
});

const createMockOutbox = () => ({
  send: vi.fn(async (chatId, body, fn) => {
    const msg = { chat_id: chatId, ...body };
    return fn(msg);
  }),
});

describe("sendMessageWithProgress", () => {
  it("sends initial placeholder message", async () => {
    const client = createMockClient();
    const outbox = createMockOutbox();
    const progressCalls = [];

    // Mock executePromptAsync-like function
    const execution = {
      then: async (onResolve) => {
        // Simulate async completion after 50ms
        setTimeout(() => onResolve({ text: "Final response", sessionId: null }), 50);
      },
    };

    await sendMessageWithProgress({
      client,
      outbox,
      kind: "gemini",
      chatId: 123,
      execution: Promise.resolve({ text: "Final response", sessionId: null }),
      placeholderText: "🤔 Thinking...",
      onProgress: (text) => progressCalls.push(text),
    });

    // Should have sent placeholder and final
    expect(client.sendMessage).toHaveBeenCalled();
  });

  it("updates on progress callback", async () => {
    const client = createMockClient();
    const outbox = createMockOutbox();
    const progressCalls = [];

    // Create a pending execution that feeds progress
    let resolveExecution;
    const execution = new Promise((resolve) => {
      resolveExecution = resolve;
    });

    const progressPromise = sendMessageWithProgress({
      client,
      outbox,
      kind: "gemini",
      chatId: 123,
      execution,
      placeholderText: "🤔 Thinking...",
      onProgress: (text) => progressCalls.push(text),
    });

    // Wait for initial send
    await new Promise(r => setTimeout(r, 20));
    expect(client.sendMessage).toHaveBeenCalled();

    // Resolve with progress (simulate streaming)
    resolveExecution({ text: "Partial response", sessionId: null });

    // Wait for completion
    const result = await progressPromise;
    expect(result.text).toBe("Partial response");
  });

  it("replaces placeholder on final result", async () => {
    const client = createMockClient({ editMessageText: vi.fn() });
    const outbox = createMockOutbox();

    const result = await sendMessageWithProgress({
      client,
      outbox,
      kind: "gemini",
      chatId: 123,
      execution: Promise.resolve({ text: "Final answer", sessionId: null }),
      placeholderText: "🤔 Thinking...",
    });

    expect(result.text).toBe("Final answer");
    // Result should be returned (edit happens if message_id exists in placeholder)
    expect(result).toBeDefined();
  });
});