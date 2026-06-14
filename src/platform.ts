/**
 * MessagingPlatform — minimal interface shared by TelegramClient and future Discord/other clients.
 * BridgeEngine accepts this interface so it can be wired with any conforming transport.
 */
export interface MessagingPlatform {
  // Polling (Telegram long-poll; Discord implementations should stub / no-op)
  getUpdates(options: any): Promise<any>;
  // Core messaging
  sendMessage(body: any): Promise<any>;
  sendRichMessage?(body: any): Promise<any>;
  sendRichMessageDraft?(body: any): Promise<any>;
  editMessageText(body: any): Promise<any>;
  sendChatAction(body: any): Promise<any>;
  answerCallbackQuery(body: any): Promise<any>;
  // Bot metadata
  setMyCommands(body: any): Promise<any>;
  // File delivery
  sendDocument(chatId: number, filePath: string, caption?: string): Promise<void>;
  sendDocumentBuffer?(body: {
    chat_id: number | string;
    bytes: Buffer;
    filename: string;
    mime_type?: string;
    caption?: string;
    [key: string]: any;
  }): Promise<any>;
  sendPhoto(chatId: number, filePath: string, caption?: string): Promise<void>;
  // Attachment download (Telegram-specific; Discord stubs may throw or no-op)
  getFilePath(fileId: string): Promise<string>;
  downloadFile(filePath: string, destPath: string): Promise<void>;
}
