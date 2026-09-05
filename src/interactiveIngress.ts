import type { TelegramMessage, TelegramUpdate } from "./types.js";

export interface InteractiveAttachment {
  fileId: string;
  fileName: string;
  mimeType?: string;
  fileSize?: number;
  kind?: "audio";
  durationSeconds?: number;
  /** Surface-provided download locator. It is metadata only; staging must validate it before fetching. */
  remoteUrl?: string;
}

export interface InteractiveSurroundingContextMessage {
  actorId: string;
  actorLabel: string;
  messageId: string;
  text: string;
}

export interface InteractiveTurnInput {
  surfaceIdentity: string;
  chatKey: string;
  actorId: string;
  messageId: string;
  text: string;
  /** Optional parent scope such as a Discord guild; never used as authority. */
  conversationScopeId?: string;
  threadId?: string;
  delivery: { chatId: number | string; chatType: string };
  attachments: InteractiveAttachment[];
  mediaGroupId?: string;
  /** Passive, read-only evidence from the same immediate surface conversation. */
  surroundingContext?: InteractiveSurroundingContextMessage[];
  /** Internal authoritative correlation for a previously claimed scheduled occurrence. */
  scheduledOccurrenceKey?: string;
}

function safeAttachmentName(value: string, fallback: string): string {
  const base = value.split(/[\\/]/).pop()?.trim() || fallback;
  const safe = base.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 180);
  return safe || fallback;
}

function telegramAttachments(message: TelegramMessage): InteractiveAttachment[] {
  if (message.photo?.length) {
    const photo = message.photo[message.photo.length - 1];
    return [{ fileId: photo.file_id, fileName: `photo_${photo.file_id}.jpg`, mimeType: "image/jpeg", ...(photo.file_size === undefined ? {} : { fileSize: photo.file_size }) }];
  }
  if (message.document) {
    const document = message.document;
    return [{ fileId: document.file_id, fileName: document.file_name ?? `document_${document.file_id}`, ...(document.mime_type ? { mimeType: document.mime_type } : {}), ...(document.file_size === undefined ? {} : { fileSize: document.file_size }) }];
  }
  return [];
}

/** Extract voice/audio metadata without changing the existing ordinary attachment path. */
export function telegramAudioAttachments(message: TelegramMessage): InteractiveAttachment[] {
  const raw = message as TelegramMessage & {
    voice?: { file_id?: string; file_unique_id?: string; duration?: number; mime_type?: string; file_size?: number };
    audio?: { file_id?: string; file_unique_id?: string; duration?: number; performer?: string; title?: string; file_name?: string; mime_type?: string; file_size?: number };
  };
  const media = raw.voice ?? raw.audio;
  if (!media?.file_id) return [];
  const isVoice = Boolean(raw.voice);
  const fallbackName = isVoice ? `voice_${media.file_id}.ogg` : `audio_${media.file_id}`;
  const fileName = safeAttachmentName(raw.audio?.file_name ?? fallbackName, fallbackName);
  return [{
    kind: "audio",
    fileId: media.file_id,
    fileName,
    mimeType: media.mime_type ?? (isVoice ? "audio/ogg" : undefined),
    ...(media.file_size === undefined ? {} : { fileSize: media.file_size }),
    ...(media.duration === undefined ? {} : { durationSeconds: media.duration }),
  }];
}

/** Build the neutral audio turn used by the voice ingress transform. */
export function adaptTelegramAudioUpdate(update: TelegramUpdate, surfaceIdentity: string, chatKey: string): InteractiveTurnInput | null {
  const message = update.message;
  if (!message?.chat || !message.from) return null;
  const attachments = telegramAudioAttachments(message);
  if (attachments.length === 0) return null;
  return {
    surfaceIdentity,
    chatKey,
    actorId: String(message.from.id),
    messageId: String(message.message_id),
    text: String(message.text ?? message.caption ?? "").trim(),
    ...(message.message_thread_id === undefined ? {} : { threadId: String(message.message_thread_id) }),
    delivery: { chatId: message.chat.id, chatType: message.chat.type ?? "private" },
    attachments,
    ...(message.media_group_id ? { mediaGroupId: message.media_group_id } : {}),
  };
}

function looksLikeAudioFile(fileName: string): boolean {
  return /\.(?:aac|flac|m4a|mp3|mp4|oga|ogg|opus|wav|webm)$/i.test(fileName);
}

/** Extract Discord audio attachment metadata. remoteUrl must be validated by the future surface stager before use. */
export function discordAudioAttachments(data: any): InteractiveAttachment[] {
  if (!Array.isArray(data?.attachments)) return [];
  return data.attachments.flatMap((attachment: any) => {
    const fileId = String(attachment?.id ?? "");
    const rawName = String(attachment?.filename ?? "");
    const mimeType = typeof attachment?.content_type === "string" ? attachment.content_type : undefined;
    if (!fileId || (!mimeType?.toLowerCase().startsWith("audio/") && !looksLikeAudioFile(rawName))) return [];
    const fallbackName = `audio_${fileId}`;
    const fileName = safeAttachmentName(rawName, fallbackName);
    const fileSize = Number.isSafeInteger(attachment?.size) && attachment.size >= 0 ? attachment.size as number : undefined;
    const durationSeconds = typeof attachment?.duration_secs === "number" && Number.isFinite(attachment.duration_secs) && attachment.duration_secs >= 0
      ? attachment.duration_secs as number
      : undefined;
    const remoteUrl = typeof attachment?.url === "string" && attachment.url ? attachment.url : undefined;
    return [{
      kind: "audio" as const,
      fileId,
      fileName,
      ...(mimeType ? { mimeType } : {}),
      ...(fileSize === undefined ? {} : { fileSize }),
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
      ...(remoteUrl ? { remoteUrl } : {}),
    }];
  });
}

/** Build a neutral Discord audio turn without enabling runtime download of arbitrary remote URLs. */
export function adaptDiscordAudioMessage(data: any, surfaceIdentity = "discord:interactive"): InteractiveTurnInput | null {
  const chatKey = String(data?.channel_id ?? "");
  const actorId = String(data?.author?.id ?? "");
  const messageId = String(data?.id ?? "");
  const attachments = discordAudioAttachments(data);
  if (!chatKey || !actorId || !messageId || attachments.length === 0) return null;
  return {
    surfaceIdentity,
    chatKey,
    actorId,
    messageId,
    text: String(data?.content ?? "").trim(),
    ...(data?.guild_id == null ? {} : { conversationScopeId: String(data.guild_id) }),
    delivery: { chatId: chatKey, chatType: data?.guild_id ? "supergroup" : "private" },
    attachments,
  };
}

export function adaptTelegramMessage(message: TelegramMessage, surfaceIdentity: string, chatKey: string): InteractiveTurnInput | null {
  if (!message.chat || !message.from) return null;
  return {
    surfaceIdentity,
    chatKey,
    actorId: String(message.from.id),
    messageId: String(message.message_id),
    text: String(message.text ?? message.caption ?? "").trim(),
    ...(message.message_thread_id === undefined ? {} : { threadId: String(message.message_thread_id) }),
    delivery: { chatId: message.chat.id, chatType: message.chat.type ?? "private" },
    attachments: telegramAttachments(message),
    ...(message.media_group_id ? { mediaGroupId: message.media_group_id } : {}),
  };
}

export function adaptTelegramUpdate(update: TelegramUpdate, surfaceIdentity: string, chatKey: string): InteractiveTurnInput | null {
  const message = update.message;
  return message ? adaptTelegramMessage(message, surfaceIdentity, chatKey) : null;
}

export function adaptDiscordMessage(data: any, surfaceIdentity = "discord:interactive"): InteractiveTurnInput | null {
  const chatKey = String(data?.channel_id ?? "");
  const actorId = String(data?.author?.id ?? "");
  const messageId = String(data?.id ?? "");
  const text = String(data?.content ?? "").trim();
  if (!chatKey || !actorId || !messageId || !text) return null;
  return {
    surfaceIdentity,
    chatKey,
    actorId,
    messageId,
    text,
    ...(data?.guild_id == null ? {} : { conversationScopeId: String(data.guild_id) }),
    delivery: { chatId: chatKey, chatType: data?.guild_id ? "supergroup" : "private" },
    attachments: [],
  };
}

type FlushFn = (groupId: string | null, turns: InteractiveTurnInput[]) => void | Promise<void>;
interface BufferEntry { timer?: NodeJS.Timeout; turns: InteractiveTurnInput[]; flushing: boolean; resolves: Array<() => void>; }
export class InteractiveTurnBuffer {
  private readonly groups = new Map<string, BufferEntry>();
  constructor(private readonly onFlush: FlushFn, private readonly timeoutMs = 1500) {}
  push(turn: InteractiveTurnInput): Promise<void> {
    if (!turn.mediaGroupId) return Promise.resolve(this.onFlush(null, [turn])).catch((error) => console.error("[InteractiveTurnBuffer] onFlush error", error));
    const key = `${turn.surfaceIdentity}:${turn.chatKey}:${turn.mediaGroupId}`;
    let entry = this.groups.get(key);
    if (entry && !entry.flushing) clearTimeout(entry.timer);
    else { entry = { turns: [], flushing: false, resolves: [] }; this.groups.set(key, entry); }
    entry.turns.push(turn);
    const pending = new Promise<void>((resolve) => entry!.resolves.push(resolve));
    entry.timer = setTimeout(() => {
      entry!.flushing = true;
      const turns = [...entry!.turns];
      const resolves = [...entry!.resolves];
      this.groups.delete(key);
      Promise.resolve(this.onFlush(turn.mediaGroupId!, turns)).catch((error) => console.error("[InteractiveTurnBuffer] onFlush error", error)).finally(() => resolves.forEach((resolve) => resolve()));
    }, this.timeoutMs);
    return pending;
  }
}
