/**
 * PURPOSE: Types and configurations definitions for Telegram and CLI integrations.
 * INPUTS: None.
 * OUTPUTS: Type and interface exports.
 * NEIGHBORS: src/cli.ts, src/db.ts, src/index.ts, src/bridge.ts
 * LOGIC: Declares central data types representing telegram payload structures, configuration schemas, and CLI returns.
 */

export type BotKind = "codex" | "antigravity" | "claude";

/**
 * Configuration for the Agent Bridge.
 * Timeout values are resolved per-CLI at runtime via resolveTimeoutsForKind().
 */
export interface BridgeConfig {
  allowedUserIds: ReadonlySet<string>;
  serviceEnvFile: string | null;
  serviceKind: BotKind | null;
  pollIntervalMs: number;
  executionMode: "safe" | "trusted";
  asyncEnabled: boolean;
  dbPath: string;
  bots: {
    codex: BotConfig;
    antigravity: BotConfig;
    claude: BotConfig;
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

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
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
  sender_chat?: {
    id: number;
    type: string;
    title?: string;
    username?: string;
  };
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
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
  chatId?: number | string;
  stdin?: string;
  /** Context for BridgeEvent emission. When provided, runCliAsync emits lifecycle events. */
  eventContext?: { runId: string; bot: "codex" | "antigravity" | "claude"; chatId: string; threadId?: string };
  /** Called with each emitted BridgeEvent. Requires eventContext to be set. */
  onEvent?: (event: import("./events/types.js").BridgeEvent) => void;
}

/**
 * CLI Invocation result.
 */
export interface CliResult {
  text: string;
  sessionId: string | null;
}
