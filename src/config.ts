/**
 * PURPOSE: Single source of truth for bot configuration across all entry points.
 * Replaces the four previously-duplicated inline bots blocks (index.ts,
 * index-interactive.ts, index-worker.ts, index-discord-interactive.ts) whose
 * drift shipped a live defect (stale kimchi model list). Epic 1, ADR-006.
 * INPUTS: process-env-shaped record.
 * OUTPUTS: BridgeConfig.bots map; token-uniqueness validation.
 * NEIGHBORS: src/index*.ts, src/types.ts
 */

import type { BotConfig, BotKind } from "./types.js";

export const KIMCHI_DEFAULT_MODELS = "kimi-k2.7,nemotron-3-ultra-fp4,minimax-m3,deepseek-v4-flash";

type Env = Record<string, string | undefined>;

export function parseModelPreference(raw: string | undefined): string[] {
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Build the four bot configs from env. Tokens are omitted by default because
 * most surfaces (interactive, worker, discord) construct engines without
 * per-bot Telegram tokens; only src/index.ts runs one polling bot per token.
 */
export function loadBotsConfig(env: Env, opts: { withTokens?: boolean } = {}): Record<BotKind, BotConfig> {
  const token = (v: string | undefined) => (opts.withTokens ? v : undefined);
  return {
    codex: {
      token: token(env.TELEGRAM_BOT_TOKEN_CODEX),
      command: env.CODEX_COMMAND || "codex",
      modelPreference: parseModelPreference(env.CODEX_MODEL_PREFERENCE),
    },
    antigravity: {
      token: token(env.TELEGRAM_BOT_TOKEN_ANTIGRAVITY || env.TELEGRAM_BOT_TOKEN_GEMINI),
      command: env.ANTIGRAVITY_COMMAND || env.GEMINI_COMMAND || "agy",
      modelPreference: parseModelPreference(env.ANTIGRAVITY_MODEL_PREFERENCE || env.GEMINI_MODEL_PREFERENCE),
    },
    claude: {
      token: token(env.TELEGRAM_BOT_TOKEN_CLAUDE),
      command: env.CLAUDE_COMMAND || "claude",
      modelPreference: parseModelPreference(env.CLAUDE_MODEL_PREFERENCE),
    },
    kimchi: {
      token: token(env.TELEGRAM_BOT_TOKEN_KIMCHI),
      command: env.KIMCHI_COMMAND || `${env.HOME || "~"}/.local/bin/kimchi`,
      modelPreference: parseModelPreference(env.KIMCHI_MODEL_PREFERENCE || KIMCHI_DEFAULT_MODELS),
    },
  };
}

/**
 * Resolve the execution mode for a specific bot kind.
 * Per-bot env vars (e.g. KIMCHI_EXECUTION_MODE) override the global
 * BRIDGE_EXECUTION_MODE. Kimchi defaults to trusted because it has no
 * interactive approval flow; other kinds default to safe.
 */
export function resolveExecutionMode(kind: BotKind, env: Env): "safe" | "trusted" {
  const perBotRaw = env[`${kind.toUpperCase()}_EXECUTION_MODE`];
  if (perBotRaw === "safe" || perBotRaw === "trusted") return perBotRaw;
  const globalRaw = env.BRIDGE_EXECUTION_MODE;
  if (globalRaw === "safe" || globalRaw === "trusted") return globalRaw;
  return kind === "kimchi" ? "trusted" : "safe";
}

/**
 * Fail fast when two surfaces are configured with the same Telegram token.
 * Two pollers on one token fight over getUpdates and Telegram rejects both —
 * this took the Antigravity bridge offline in production (Risk R2).
 */
export function validateTokenUniqueness(tokens: Record<string, string | undefined>): void {
  const seen = new Map<string, string>();
  for (const [surface, tok] of Object.entries(tokens)) {
    if (!tok) continue;
    const existing = seen.get(tok);
    if (existing) {
      throw new Error(
        `Duplicate Telegram bot token: surfaces "${existing}" and "${surface}" share the same token. ` +
        `Each polling surface needs its own bot token (two getUpdates pollers on one token conflict).`
      );
    }
    seen.set(tok, surface);
  }
}
