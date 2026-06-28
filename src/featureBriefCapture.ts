/**
 * PURPOSE: In-process store for pending feature brief captures.
 * When a user sends a bare /feature command, the next plain message from
 * that chat is treated as the feature brief instead of being forwarded to
 * the CLI. State is keyed by chatKey (string of chatId).
 * NEIGHBORS: src/workerBot.ts, src/index-worker.ts
 */

const pendingBriefs = new Map<string, true>();

export function setPendingFeatureBrief(chatKey: string): void {
  pendingBriefs.set(chatKey, true);
}

export function hasPendingFeatureBrief(chatKey: string): boolean {
  return pendingBriefs.has(chatKey);
}

export function clearPendingFeatureBrief(chatKey: string): void {
  pendingBriefs.delete(chatKey);
}

/**
 * If a brief capture is pending for this chat, consume it and return the
 * message text as the brief. Returns null if nothing was pending.
 */
export function captureFeatureBrief(chatKey: string, text: string): string | null {
  if (!pendingBriefs.has(chatKey)) return null;
  pendingBriefs.delete(chatKey);
  return text;
}

/**
 * Store a pending repo-brief for deferred repo selection.
 * Associates a chatKey with a brief text to be consumed later.
 */
const pendingRepoBriefs = new Map<string, string>();

export function setPendingRepoBrief(chatKey: string, brief: string): void {
  pendingRepoBriefs.set(chatKey, brief);
}

/**
 * Consume and return the pending repo-brief for this chat.
 * Returns null if nothing was pending. Clears the stored brief on retrieval.
 */
export function consumePendingRepoBrief(chatKey: string): string | null {
  const brief = pendingRepoBriefs.get(chatKey) ?? null;
  if (brief !== null) pendingRepoBriefs.delete(chatKey);
  return brief;
}
