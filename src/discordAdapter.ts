import type { DiscordUpdate } from "./discord.js";
import type { MessagingPlatform } from "./platform.js";
import type { TelegramMessage, TelegramUpdate } from "./types.js";

export function numericId(snowflake: string): number {
  const n = BigInt(snowflake || "0");
  return Number(n % BigInt(Number.MAX_SAFE_INTEGER));
}

export function discordMessageToTelegramUpdate(
  update: DiscordUpdate,
  allowedUserIds: Set<string>,
): TelegramUpdate | null {
  if (update.type !== "MESSAGE_CREATE") return null;

  const d = update.data;
  const authorId = String(d.author?.id ?? "");
  if (!allowedUserIds.has(authorId)) return null;
  if (d.author?.bot) return null;

  const message: TelegramMessage = {
    message_id: numericId(d.id ?? "0"),
    chat: {
      id: numericId(d.channel_id ?? "0"),
      type: d.guild_id ? "supergroup" : "private",
    },
    from: {
      id: numericId(authorId),
      first_name: d.author?.username ?? "Discord User",
    },
    text: d.content ?? "",
  };

  if (d.thread) {
    message.message_thread_id = numericId(d.channel_id ?? "0");
  }

  return { update_id: numericId(d.id ?? "0"), message };
}

export class DiscordTelegramPlatformAdapter implements MessagingPlatform {
  constructor(
    private readonly inner: MessagingPlatform,
    private readonly aliases = new Map<string, string>(),
  ) {}

  rememberSnowflakeAlias(snowflake: string): number {
    const alias = numericId(snowflake);
    this.aliases.set(String(alias), snowflake);
    return alias;
  }

  getUpdates(options: any): Promise<any> {
    return this.inner.getUpdates(options);
  }

  sendMessage(body: any): Promise<any> {
    return this.inner.sendMessage(this.rewriteBody(body));
  }

  editMessageText(body: any): Promise<any> {
    return this.inner.editMessageText(this.rewriteBody(body));
  }

  sendChatAction(body: any): Promise<any> {
    return this.inner.sendChatAction(this.rewriteBody(body));
  }

  answerCallbackQuery(body: any): Promise<any> {
    return this.inner.answerCallbackQuery(body);
  }

  setMyCommands(body: any): Promise<any> {
    return this.inner.setMyCommands(body);
  }

  sendDocument(chatId: number | string, filePath: string, caption?: string): Promise<void> {
    const sendDocument = this.inner.sendDocument as (
      resolvedChatId: number | string,
      filePath: string,
      caption?: string,
    ) => Promise<void>;
    return sendDocument.call(this.inner, this.resolveSnowflake(chatId), filePath, caption);
  }

  sendPhoto(chatId: number | string, filePath: string, caption?: string): Promise<void> {
    const sendPhoto = this.inner.sendPhoto as (
      resolvedChatId: number | string,
      filePath: string,
      caption?: string,
    ) => Promise<void>;
    return sendPhoto.call(this.inner, this.resolveSnowflake(chatId), filePath, caption);
  }

  getFilePath(fileId: string): Promise<string> {
    return this.inner.getFilePath(fileId);
  }

  downloadFile(filePath: string, destPath: string): Promise<void> {
    return this.inner.downloadFile(filePath, destPath);
  }

  private rewriteBody(body: any): any {
    const chatId = body?.chat_id ?? body?.channel_id;
    if (chatId == null) return body;
    const snowflake = this.resolveSnowflake(chatId);
    return { ...body, chat_id: snowflake, channel_id: snowflake };
  }

  private resolveSnowflake(id: number | string): string {
    return this.aliases.get(String(id)) ?? String(id);
  }
}
