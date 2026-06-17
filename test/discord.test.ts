import { describe, it, expect, vi, beforeEach } from "vitest";
import { chunkText, MAX_DISCORD_MESSAGE_LENGTH, DiscordClient } from "../src/discord.js";

describe("chunkText", () => {
  it("returns a single chunk when text is within limit", () => {
    const text = "hello world";
    expect(chunkText(text)).toEqual([text]);
  });

  it("returns a single chunk when text is exactly the limit", () => {
    const text = "x".repeat(MAX_DISCORD_MESSAGE_LENGTH);
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(MAX_DISCORD_MESSAGE_LENGTH);
  });

  it("splits text that exceeds the limit into multiple chunks", () => {
    const text = "a".repeat(MAX_DISCORD_MESSAGE_LENGTH * 2 + 100);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= MAX_DISCORD_MESSAGE_LENGTH)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("chunk boundary is exactly MAX_DISCORD_MESSAGE_LENGTH chars", () => {
    const text = "b".repeat(MAX_DISCORD_MESSAGE_LENGTH + 1);
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(MAX_DISCORD_MESSAGE_LENGTH);
    expect(chunks[1]).toHaveLength(1);
  });
});

describe("DiscordClient", () => {
  const baseOpts = {
    token: "test-token",
    applicationId: "app-123",
    onUpdate: vi.fn(),
  };

  describe("sendMessage", () => {
    it("posts to /channels/{id}/messages with content", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: "msg-1" }),
      });
      const client = new DiscordClient(baseOpts, fetchMock);
      await client.sendMessage({ chat_id: "999", text: "hello" });
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain("/channels/999/messages");
      expect(JSON.parse(init.body).content).toBe("hello");
    });

    it("sends multiple requests for text over the limit", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: "msg-1" }),
      });
      const client = new DiscordClient(baseOpts, fetchMock);
      const longText = "z".repeat(MAX_DISCORD_MESSAGE_LENGTH * 2 + 50);
      await client.sendMessage({ chat_id: "999", text: longText });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("renders markdown tables when DISCORD_MARKDOWN_IR_ENABLED is true", async () => {
      const previous = process.env.DISCORD_MARKDOWN_IR_ENABLED;
      process.env.DISCORD_MARKDOWN_IR_ENABLED = "true";
      try {
        const fetchMock = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ id: "msg-1" }),
        });
        const client = new DiscordClient(baseOpts, fetchMock);
        await client.sendMessage({
          chat_id: "999",
          text: "| Name | Age |\n| --- | --- |\n| Alice | 30 |",
        });
        const [, init] = fetchMock.mock.calls[0];
        expect(JSON.parse(init.body).content).toBe("**Name:** Alice\n- **Age:** 30");
      } finally {
        if (previous === undefined) delete process.env.DISCORD_MARKDOWN_IR_ENABLED;
        else process.env.DISCORD_MARKDOWN_IR_ENABLED = previous;
      }
    });

    it("sends raw markdown unchanged when DISCORD_MARKDOWN_IR_ENABLED is false", async () => {
      delete process.env.DISCORD_MARKDOWN_IR_ENABLED;
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: "msg-1" }),
      });
      const client = new DiscordClient(baseOpts, fetchMock);
      const rawTable = "| Name | Age |\n| --- | --- |\n| Alice | 30 |";
      await client.sendMessage({ chat_id: "999", text: rawTable });
      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse(init.body).content).toBe(rawTable);
    });
  });

  describe("sendChatAction (typing indicator)", () => {
    it("posts to /channels/{id}/typing", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        json: async () => null,
      });
      const client = new DiscordClient(baseOpts, fetchMock);
      await client.sendChatAction({ chat_id: "42" });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain("/channels/42/typing");
      expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    });
  });

  describe("setMyCommands", () => {
    it("uses guild scope when guildId is set", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [],
      });
      const client = new DiscordClient({ ...baseOpts, guildId: "guild-99" }, fetchMock);
      await client.setMyCommands({ commands: [{ command: "help", description: "Get help" }] });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain("/guilds/guild-99/commands");
    });

    it("uses global scope when no guildId", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [],
      });
      const client = new DiscordClient(baseOpts, fetchMock);
      await client.setMyCommands({ commands: [{ command: "help", description: "Get help" }] });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain("/applications/app-123/commands");
      expect(url).not.toContain("/guilds/");
    });
  });

  describe("getFilePath / downloadFile", () => {
    it("throws a clear error since Discord does not have Telegram's getFilePath", async () => {
      const client = new DiscordClient(baseOpts, vi.fn());
      await expect(client.getFilePath("file-id")).rejects.toThrow(/not supported on Discord/);
    });

    it("throws a clear error for downloadFile", async () => {
      const client = new DiscordClient(baseOpts, vi.fn());
      await expect(client.downloadFile("remote", "/tmp/dest")).rejects.toThrow(/not supported on Discord/);
    });
  });

  describe("getUpdates (stub)", () => {
    it("returns empty result immediately — Discord uses WebSocket push", async () => {
      const client = new DiscordClient(baseOpts, vi.fn());
      const result = await client.getUpdates({});
      expect(result).toEqual({ result: [], ok: true });
    });
  });
});
