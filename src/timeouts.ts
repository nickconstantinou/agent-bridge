import type { BotKind } from "./types.js";

interface PerKindDefaults {
  cliTimeoutMs: number;
  cliIdleTimeoutMs: number;
}

// Per-CLI built-in defaults. Gemini thinks silently the longest; Codex streams frequently.
const DEFAULTS: Record<BotKind, PerKindDefaults> = {
  codex:  { cliTimeoutMs: 600_000, cliIdleTimeoutMs:  90_000 },
  gemini: { cliTimeoutMs: 600_000, cliIdleTimeoutMs: 240_000 },
  claude: { cliTimeoutMs: 600_000, cliIdleTimeoutMs: 180_000 },
};

const DEFAULT_FETCH_TIMEOUT_MS = 45_000;

function envNum(name: string): number | null {
  const v = process.env[name];
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface ResolvedTimeouts {
  cliTimeoutMs: number;
  cliIdleTimeoutMs: number;
  fetchTimeoutMs: number;
}

/**
 * Resolve timeout values for a specific bot kind.
 *
 * Precedence (highest first):
 *   1. Per-CLI env var  — e.g. GEMINI_CLI_TIMEOUT_MS, GEMINI_CLI_IDLE_TIMEOUT_MS
 *   2. Global env var   — CLI_TIMEOUT_MS, CLI_IDLE_TIMEOUT_MS
 *   3. Built-in default — per-kind table above
 *
 * Fetch timeout (Telegram HTTP only, never kills CLI subprocess):
 *   TELEGRAM_FETCH_TIMEOUT_MS → FETCH_TIMEOUT_MS → 45 000 ms
 */
export function resolveTimeoutsForKind(kind: BotKind): ResolvedTimeouts {
  const prefix = kind.toUpperCase();
  const defaults = DEFAULTS[kind];
  return {
    cliTimeoutMs:
      envNum(`${prefix}_CLI_TIMEOUT_MS`) ??
      envNum("CLI_TIMEOUT_MS") ??
      defaults.cliTimeoutMs,
    cliIdleTimeoutMs:
      envNum(`${prefix}_CLI_IDLE_TIMEOUT_MS`) ??
      envNum("CLI_IDLE_TIMEOUT_MS") ??
      defaults.cliIdleTimeoutMs,
    fetchTimeoutMs:
      envNum("TELEGRAM_FETCH_TIMEOUT_MS") ??
      envNum("FETCH_TIMEOUT_MS") ??
      DEFAULT_FETCH_TIMEOUT_MS,
  };
}
