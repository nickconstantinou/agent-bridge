import type { BotKind } from "./types.js";

interface PerKindDefaults {
  cliTimeoutMs: number;
  cliIdleTimeoutMs: number;
}

// Per-CLI built-in defaults.
// All kinds: 30m hard timeout, 20m idle timeout.
// Idle timeout guards silent hangs; 20m is generous enough for long inference phases
// while still recovering from genuine stalls within a reasonable window.
const DEFAULTS: Record<BotKind, PerKindDefaults> = {
  codex:       { cliTimeoutMs: 1_800_000, cliIdleTimeoutMs: 1_200_000 },
  antigravity: { cliTimeoutMs: 1_800_000, cliIdleTimeoutMs: 1_200_000 },
  claude:      { cliTimeoutMs: 1_800_000, cliIdleTimeoutMs: 1_200_000 },
  kimchi:      { cliTimeoutMs: 1_800_000, cliIdleTimeoutMs: 1_200_000 },
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
 *   1. Per-CLI env var  — e.g. ANTIGRAVITY_CLI_TIMEOUT_MS, ANTIGRAVITY_CLI_IDLE_TIMEOUT_MS
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
