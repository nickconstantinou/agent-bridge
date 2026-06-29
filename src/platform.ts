/**
 * MessagingPlatform — minimal interface shared by TelegramClient and future Discord/other clients.
 * BridgeEngine accepts this interface so it can be wired with any conforming transport.
 */
export type PlatformChatId = number | string;

type PlatformExtraFields = Record<string, unknown>;

export interface PlatformResponse<T = unknown> {
  ok?: boolean;
  result?: T;
  description?: string;
  parameters?: Record<string, unknown>;
}

export type GetUpdatesOptions = PlatformExtraFields & {
  offset?: number;
  timeout?: number;
  allowed_updates?: string[];
};

type MessageAddress =
  | { chat_id: PlatformChatId; channel_id?: string }
  | { channel_id: string; chat_id?: PlatformChatId };

type MessageContent =
  | { text: string; content?: string }
  | { content: string; text?: string };

export type SendMessageBody = PlatformExtraFields & MessageAddress & MessageContent;

export type SendRichMessageBody = PlatformExtraFields & MessageAddress & {
  rich_message: {
    html: string;
  };
};

type EditableMessage =
  | { message_id: number | string; inline_message_id?: string }
  | { inline_message_id: string; message_id?: number | string };

export type EditMessageTextBody = PlatformExtraFields & MessageAddress & EditableMessage & MessageContent;

export type SendChatActionBody = PlatformExtraFields & MessageAddress & {
  action?: string;
};

export type AnswerCallbackQueryBody = PlatformExtraFields & (
  | {
      callback_query_id: string;
      text?: string;
      show_alert?: boolean;
      url?: string;
      cache_time?: number;
    }
  | {
      interaction_id: string;
      interaction_token: string;
      text?: string;
      type?: number;
      data?: Record<string, unknown>;
    }
);

export type PlatformCommandOption = PlatformExtraFields & {
  name: string;
  description?: string;
  type?: number;
  required?: boolean;
};

export type PlatformCommand = PlatformExtraFields & (
  | { command: string; name?: string }
  | { name: string; command?: string }
) & {
  description: string;
  type?: number;
  options?: PlatformCommandOption[];
};

export interface SetMyCommandsBody extends PlatformExtraFields {
  commands: PlatformCommand[];
}

export interface SendDocumentBufferBody extends PlatformExtraFields {
  chat_id: PlatformChatId;
  bytes: Buffer;
  filename: string;
  mime_type?: string;
  caption?: string;
}

export interface MessagingPlatform {
  // Polling (Telegram long-poll; Discord implementations should stub / no-op)
  getUpdates(options: GetUpdatesOptions): Promise<PlatformResponse<unknown[]>>;
  // Core messaging
  sendMessage(body: SendMessageBody): Promise<PlatformResponse<unknown>>;
  sendRichMessage?(body: SendRichMessageBody): Promise<PlatformResponse<unknown>>;
  sendRichMessageDraft?(body: SendRichMessageBody): Promise<PlatformResponse<unknown>>;
  editMessageText(body: EditMessageTextBody): Promise<PlatformResponse<unknown>>;
  sendChatAction(body: SendChatActionBody): Promise<PlatformResponse<unknown>>;
  answerCallbackQuery(body: AnswerCallbackQueryBody): Promise<PlatformResponse<unknown>>;
  // Bot metadata
  setMyCommands(body: SetMyCommandsBody): Promise<PlatformResponse<unknown>>;
  // File delivery
  sendDocument(chatId: PlatformChatId, filePath: string, caption?: string): Promise<void>;
  sendDocumentBuffer?(body: SendDocumentBufferBody): Promise<PlatformResponse<unknown>>;
  sendPhoto(chatId: PlatformChatId, filePath: string, caption?: string): Promise<void>;
  // Attachment download (Telegram-specific; Discord stubs may throw or no-op)
  getFilePath(fileId: string): Promise<string>;
  downloadFile(filePath: string, destPath: string): Promise<void>;
}
