import Database from "better-sqlite3";
import { HealthContextStore } from "./context.js";
import { formatReport, formatSuggestion } from "./reporter.js";
import type { HealthReport, AutonomyLevel } from "./types.js";
import type { BotKind } from "../types.js";

type SuggestFn = (
  report: HealthReport,
  bot: BotKind,
  botConfig: { command: string; modelPreference: string[] },
) => Promise<string | null>;

export interface HealthBridgeBotOptions {
  db: Database.Database;
  chatId: number;
  sessionTtlSeconds: number;
  autonomy: AutonomyLevel;
  cliBot: BotKind;
  cliBotConfig: { command: string; modelPreference: string[] };
  _sendText?: (text: string) => Promise<void>;
  _suggestFn?: SuggestFn;
}

export class HealthBridgeBot {
  private contextStore: HealthContextStore;
  private chatId: number;
  private sessionTtlSeconds: number;
  private autonomy: AutonomyLevel;
  private cliBot: BotKind;
  private cliBotConfig: { command: string; modelPreference: string[] };
  private sendTextImpl: (text: string) => Promise<void>;
  private suggestFn: SuggestFn;

  constructor(options: HealthBridgeBotOptions) {
    this.contextStore = new HealthContextStore(options.db);
    this.chatId = options.chatId;
    this.sessionTtlSeconds = options.sessionTtlSeconds;
    this.autonomy = options.autonomy;
    this.cliBot = options.cliBot;
    this.cliBotConfig = options.cliBotConfig;
    this.sendTextImpl = options._sendText ?? (async () => {});
    this.suggestFn = options._suggestFn ?? (async (report, bot, config) => {
      const { generateSuggestion } = await import("./suggest.js");
      return generateSuggestion(report, bot, config);
    });
  }

  async handleReport(report: HealthReport, options?: { force?: boolean; silent?: boolean }): Promise<void> {
    this.contextStore.saveReport(report);
    if (!options?.silent && (report.status !== "green" || options?.force)) {
      await this.sendTextImpl(formatReport(report));
    }

    if (!options?.silent && this.autonomy !== "report" && report.status !== "green") {
      const suggestion = await this.suggestFn(report, this.cliBot, this.cliBotConfig);
      if (suggestion) {
        this.contextStore.saveSuggestion(suggestion);
        await this.sendTextImpl(formatSuggestion(suggestion));
      }
    }
  }

  buildOnDemandPrompt(userMessage: string): string {
    const prefix = this.contextStore.buildContextPrefix();
    if (!prefix) return userMessage;
    return `${prefix}\n\n${userMessage}`;
  }

  getActiveSessionId(): string | null {
    if (!this.contextStore.isSessionActive(this.sessionTtlSeconds)) return null;
    return this.contextStore.getContext()?.sessionId ?? null;
  }

  saveSession(sessionId: string): void {
    this.contextStore.saveSession(sessionId);
  }

  clearSession(): void {
    this.contextStore.clearSession();
  }
}
