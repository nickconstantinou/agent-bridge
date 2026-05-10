import type { BridgeStateData } from "./types.js";

/**
 * Processes a Telegram update, handling deduplication.
 */
export async function processTelegramUpdate(
  kind: string,
  update: any,
  bridgeState: any,
  handleUpdate: (update: any) => Promise<void>
): Promise<void> {
  const updateId = update.update_id;
  if (!updateId) return;

  const isAccepted = await bridgeState.isUpdateAccepted(kind, updateId);
  if (isAccepted) return;

  const processedId = await bridgeState.getProcessedUpdateId(kind);
  if (updateId <= processedId) return;

  await bridgeState.acceptUpdate(kind, updateId);
  try {
    await handleUpdate(update);
    await bridgeState.completeUpdate(kind, updateId);
  } catch (error) {
    // If it failed, it stays in accepted but not processed, 
    // OR we could remove it from accepted to retry.
    // For now, we leave it to prevent infinite loops of failing updates.
    throw error;
  }
}
