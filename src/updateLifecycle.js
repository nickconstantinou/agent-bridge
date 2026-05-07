export async function processTelegramUpdate(kind, update, bridgeState, handleUpdate) {
  const updateId = update.update_id;
  if (await bridgeState.hasAcceptedUpdate(kind, updateId)) {
    await bridgeState.completeUpdate(kind, updateId);
    return;
  }

  await bridgeState.acceptUpdate(kind, updateId);
  await handleUpdate(update);
  await bridgeState.completeUpdate(kind, updateId);
}
