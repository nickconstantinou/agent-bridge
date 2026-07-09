/**
 * PURPOSE: Persistent per-chat/per-CLI one-time handoff state. Marks that the
 * next execution for a given chat+CLI pair must receive injected Agent
 * Bridge context (a fresh CLI session started via manual switch or capacity
 * fallback), then clears itself after that context has been consumed once.
 * This is a standalone primitive — nothing calls it yet; wiring into the
 * manual-switch/fallback dispatch path is a later, separately-tested PR.
 * NEIGHBORS: src/db.ts, src/engine.ts
 */

import type { BridgeDb } from "./db.js";

type HandoffDb = Pick<BridgeDb, "getSetting" | "setSetting">;

export function handoffRequiredSettingKey(chatKey: string, cliKind: string): string {
  return `handoff_required:${chatKey}:${cliKind}`;
}

export function markHandoffRequired(
  db: HandoffDb,
  chatKey: string,
  cliKind: string,
  reason: string,
): void {
  db.setSetting(
    handoffRequiredSettingKey(chatKey, cliKind),
    JSON.stringify({ reason, at: new Date().toISOString() }),
  );
}

export function isHandoffRequired(db: HandoffDb, chatKey: string, cliKind: string): boolean {
  return db.getSetting(handoffRequiredSettingKey(chatKey, cliKind)) != null;
}

export function clearHandoffRequired(db: HandoffDb, chatKey: string, cliKind: string): void {
  db.setSetting(handoffRequiredSettingKey(chatKey, cliKind), null);
}

/**
 * Checks and clears the flag atomically (from the caller's perspective —
 * there is no concurrent writer for a single chat+CLI pair in this process
 * model). Returns true exactly once per markHandoffRequired() call.
 */
export function consumeHandoffRequired(db: HandoffDb, chatKey: string, cliKind: string): boolean {
  if (!isHandoffRequired(db, chatKey, cliKind)) return false;
  clearHandoffRequired(db, chatKey, cliKind);
  return true;
}
