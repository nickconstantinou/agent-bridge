import { describe, expect, it, vi } from "vitest";
import type { MessagingPlatform } from "../src/platform.js";

async function loadDiscordAdapter(): Promise<any> {
  try {
    return await import("../src/discordAdapter.js");
  } catch (error) {
    throw new Error(`Expected shared Discord adapter module to be importable: ${String(error)}`);
  }
}

function expectedNumericId(snowflake: string): number {
  return Number(BigInt(snowflake || "0") % BigInt(Number.MAX_SAFE_INTEGER));
}

function makeInnerPlatform(): MessagingPlatform {
  return {
    getUpdates: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ ok: true }),
    editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
    setMyCommands: vi.fn().mockResolvedValue({ ok: true }),
    sendDocument: vi.fn().mockResolvedValue(undefined),
    sendPhoto: vi.fn().mockResolvedValue(undefined),
    getFilePath: vi.fn().mockResolvedValue(""),
    downloadFile: vi.fn().mockResolvedValue(undefined),
  };
}

describe("numericId", () => {
  it("converts a Discord snowflake into a safe Telegram-compatible number", async () => {
    const { numericId } = await loadDiscordAdapter();
    const snowflake = "1234567890123456789";

    expect(numericId(snowflake)).toBe(expectedNumericId(snowflake));
    expect(Number.isSafeInteger(numericId(snowflake))).toBe(true);
  });

  it("treats an empty snowflake as zero", async () => {
    const { numericId } = await loadDiscordAdapter();

    expect(numericId("")).toBe(0);
  });
});

describe("discordMessageToTelegramUpdate", () => {
  it("maps an allowed Discord message into a Telegram-compatible update", async () => {
    const { discordMessageToTelegramUpdate } = await loadDiscordAdapter();
    const update = discordMessageToTelegramUpdate(
      {
        type: "MESSAGE_CREATE",
        data: {
          id: "200000000000000002",
          channel_id: "100000000000000001",
          guild_id: "300000000000000003",
          author: { id: "400000000000000004", username: "ada" },
          content: "hello from discord",
        },
      },
      new Set(["400000000000000004"]),
    );

    expect(update).toEqual({
      update_id: expectedNumericId("200000000000000002"),
      message: {
        message_id: expectedNumericId("200000000000000002"),
        chat: {
          id: expectedNumericId("100000000000000001"),
          type: "supergroup",
        },
        from: {
          id: expectedNumericId("400000000000000004"),
          first_name: "ada",
        },
        text: "hello from discord",
      },
    });
  });

  it("maps Discord thread channels to Telegram message_thread_id", async () => {
    const { discordMessageToTelegramUpdate } = await loadDiscordAdapter();
    const update = discordMessageToTelegramUpdate(
      {
        type: "MESSAGE_CREATE",
        data: {
          id: "200000000000000002",
          channel_id: "100000000000000001",
          guild_id: "300000000000000003",
          thread: { id: "100000000000000001" },
          author: { id: "400000000000000004", username: "ada" },
          content: "thread reply",
        },
      },
      new Set(["400000000000000004"]),
    );

    expect(update?.message?.message_thread_id).toBe(expectedNumericId("100000000000000001"));
  });

  it("returns null for unsupported events, bot authors, and disallowed users", async () => {
    const { discordMessageToTelegramUpdate } = await loadDiscordAdapter();

    expect(
      discordMessageToTelegramUpdate(
        { type: "INTERACTION_CREATE", data: {} },
        new Set(["400000000000000004"]),
      ),
    ).toBeNull();

    expect(
      discordMessageToTelegramUpdate(
        {
          type: "MESSAGE_CREATE",
          data: {
            id: "200000000000000002",
            channel_id: "100000000000000001",
            author: { id: "400000000000000004", username: "ada", bot: true },
            content: "ignore me",
          },
        },
        new Set(["400000000000000004"]),
      ),
    ).toBeNull();

    expect(
      discordMessageToTelegramUpdate(
        {
          type: "MESSAGE_CREATE",
          data: {
            id: "200000000000000002",
            channel_id: "100000000000000001",
            author: { id: "400000000000000004", username: "ada" },
            content: "ignore me",
          },
        },
        new Set(["999999999999999999"]),
      ),
    ).toBeNull();
  });
});

describe("DiscordTelegramPlatformAdapter", () => {
  it("rewrites Telegram numeric chat ids back to Discord snowflakes for outbound calls", async () => {
    const { DiscordTelegramPlatformAdapter } = await loadDiscordAdapter();
    const inner = makeInnerPlatform();
    const adapter = new DiscordTelegramPlatformAdapter(inner);
    const chatId = adapter.rememberSnowflakeAlias("100000000000000001");

    await adapter.sendMessage({ chat_id: chatId, text: "hello" });
    await adapter.editMessageText({ chat_id: chatId, message_id: 42, text: "updated" });
    await adapter.sendChatAction({ chat_id: chatId });

    expect(inner.sendMessage).toHaveBeenCalledWith({
      chat_id: "100000000000000001",
      channel_id: "100000000000000001",
      text: "hello",
    });
    expect(inner.editMessageText).toHaveBeenCalledWith({
      chat_id: "100000000000000001",
      channel_id: "100000000000000001",
      message_id: 42,
      text: "updated",
    });
    expect(inner.sendChatAction).toHaveBeenCalledWith({
      chat_id: "100000000000000001",
      channel_id: "100000000000000001",
    });
  });

  it("rewrites media helper chat ids using the remembered snowflake alias", async () => {
    const { DiscordTelegramPlatformAdapter } = await loadDiscordAdapter();
    const inner = makeInnerPlatform();
    const adapter = new DiscordTelegramPlatformAdapter(inner);
    const chatId = adapter.rememberSnowflakeAlias("100000000000000001");

    await adapter.sendDocument(chatId, "/tmp/report.txt", "report");
    await adapter.sendPhoto(chatId, "/tmp/photo.png", "photo");

    expect(inner.sendDocument).toHaveBeenCalledWith(
      "100000000000000001",
      "/tmp/report.txt",
      "report",
    );
    expect(inner.sendPhoto).toHaveBeenCalledWith(
      "100000000000000001",
      "/tmp/photo.png",
      "photo",
    );
  });
});
