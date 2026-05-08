import { describe, expect, it } from "vitest";
import { sendTelegramMessage } from "../src/messageDelivery.js";

function createFailingClient({ failOn = [] }) {
  const calls = [];
  let index = 0;
  return {
    calls,
    client: {
      async sendMessage(message) {
        calls.push(message);
        const shouldFail = failOn[index] || null;
        index += 1;
        if (shouldFail === "raw") throw new Error("raw markdown failed");
        if (shouldFail === "escaped") throw new Error("escaped markdown failed");
        return { ok: true };
      },
    },
  };
}

describe("message delivery", () => {
  it("uses raw MarkdownV2 when it succeeds", async () => {
    const { client, calls } = createFailingClient({ failOn: [] });
    const outbox = {
      async send(_chatId, message, sendFn) {
        return sendFn(message);
      },
    };

    await sendTelegramMessage({
      client,
      outbox,
      kind: "gemini",
      chatId: 1,
      body: { text: "hello *world*" },
    });

    expect(calls[0].parse_mode).toBe("MarkdownV2");
    expect(calls[0].text).toBe("hello *world*");
  });

  it("falls back to escaped MarkdownV2 and then plain text", async () => {
    const calls = [];
    const client = {
      async sendMessage(message) {
        calls.push(message);
        if (calls.length === 1) throw new Error("raw markdown failed");
        if (calls.length === 2) throw new Error("escaped markdown failed");
        return { ok: true };
      },
    };
    const outbox = {
      async send(_chatId, message, sendFn) {
        return sendFn(message);
      },
    };

    await sendTelegramMessage({
      client,
      outbox,
      kind: "gemini",
      chatId: 1,
      body: { text: "hello *world*" },
    });

    expect(calls).toHaveLength(3);
    expect(calls[1].text).toContain("\\*");
    expect(calls[2].parse_mode).toBeUndefined();
  });

  it("keeps long mixed content in order", async () => {
    const calls = [];
    const client = {
      async sendMessage(message) {
        calls.push(message);
        return { ok: true };
      },
    };
    const outbox = {
      async send(_chatId, message, sendFn) {
        return sendFn(message);
      },
    };

    await sendTelegramMessage({
      client,
      outbox,
      kind: "codex",
      chatId: 1,
      body: { text: `${"a".repeat(1800)}\n\n\`\`\`js\n${"b".repeat(1800)}\n\`\`\`\n\n${"c".repeat(1800)}` },
    });

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.map((entry) => entry.text).join("")).toContain("a".repeat(120));
    expect(calls.map((entry) => entry.text).join("")).toContain("b".repeat(120));
    expect(calls.map((entry) => entry.text).join("")).toContain("c".repeat(120));
  });
});
