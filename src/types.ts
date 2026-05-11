/**
 * Configuration for the Agent Bridge.
 */
export interface BridgeConfig {
  allowedUserId: string;
  serviceEnvFile: string | null;
  serviceKind: "codex" | "gemini" | null;
  pollIntervalMs: number;
  executionMode: "safe" | "trusted";
  cliTimeoutMs: number;
  geminiFallbackTimeoutMs: number;
  asyncEnabled: boolean;
  dbPath: string;
  bots: {
    codex: BotConfig;
    gemini: BotConfig;
  };
}

/**
 * Configuration for an individual bot.
 */
export interface BotConfig {
  token: string | undefined;
  command: string;
  modelPreference: string[];  // [0] = default, rest = fallbacks in priority order
}

/**
 * Telegram Update object.
 */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

/**
 * Telegram Message object.
 */
export interface TelegramMessage {
  message_id: number;
  chat: {
    id: number;
    type: string;
    title?: string;
  };
  from?: {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
  };
  text?: string;
  caption?: string;
  media_group_id?: string;
  message_thread_id?: number;
  reply_markup?: any;
}

/**
 * Telegram Callback Query object.
 */
export interface TelegramCallbackQuery {
  id: string;
  from: {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
  };
  message?: TelegramMessage;
  data?: string;
}

/**
 * CLI Execution Options.
 */
export interface CliOptions {
  timeoutMs?: number;
  idleTimeoutMs?: number | null;
  killGraceMs?: number;
  onProgress?: (text: string) => void;
  onCancel?: (kill: () => void) => void;
  chatId?: number | string;
}

/**
 * CLI Invocation result.
 */
export interface CliResult {
  text: string;
  sessionId: string | null;
}

