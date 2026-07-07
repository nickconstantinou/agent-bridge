/**
 * PURPOSE: Shared env-driven context injection / pre-seed compaction policy readers.
 * Read live (not cached) so tests can change env vars per-process without a module reload.
 * NEIGHBORS: src/engine.ts, src/commands.ts
 */

export type ContextInjectionPolicy = "always" | "handoff_once";

/**
 * "always" (default, current OSS behavior): inject full Agent Bridge context
 * on every turn regardless of session/handoff state.
 * "handoff_once" (recommended for platform-managed deployments): inject only
 * when there is no native CLI session, a handoff is pending, or /compact /
 * invalid-session recovery just reset the session — then rely on the
 * provider-native session for continuity until the next such event.
 */
export function contextInjectionPolicy(): ContextInjectionPolicy {
  return process.env.BRIDGE_CONTEXT_INJECTION_POLICY === "handoff_once" ? "handoff_once" : "always";
}

export const PRESEED_COMPACT_CHARS_DEFAULT = 30_000;

/** BRIDGE_PRESEED_COMPACT_MODE=auto enables minimal pre-seed compaction ahead of a
 * fresh-seed handoff_once turn; default "off" leaves fresh-seed context untouched. */
export function preseedCompactMode(): "off" | "auto" {
  return process.env.BRIDGE_PRESEED_COMPACT_MODE === "auto" ? "auto" : "off";
}

export function preseedCompactCharThreshold(): number {
  return parseInt(process.env.BRIDGE_PRESEED_COMPACT_CHARS ?? "") || PRESEED_COMPACT_CHARS_DEFAULT;
}
