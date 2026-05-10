import { createFileStore } from "./store.js";
import type { BridgeStateData, Store } from "./types.js";

/**
 * State management for the bridge.
 */
export function createBridgeState(store: Store<BridgeStateData>) {
  return {
    async read(): Promise<BridgeStateData> {
      return store.read();
    },

    async getProcessedUpdateId(kind: string): Promise<number> {
      const data = await store.read();
      return data.processedUpdates[kind] ?? 0;
    },

    async setProcessedUpdateId(kind: string, updateId: number): Promise<void> {
      const current = await store.read();
      await store.write({
        processedUpdates: {
          ...current.processedUpdates,
          [kind]: updateId,
        },
      });
    },

    async isUpdateAccepted(kind: string, updateId: number): Promise<boolean> {
      const data = await store.read();
      const accepted = data.acceptedUpdates[kind] || [];
      return accepted.includes(updateId);
    },

    async acceptUpdate(kind: string, updateId: number): Promise<void> {
      const current = await store.read();
      const accepted = [...(current.acceptedUpdates[kind] || []), updateId];
      await store.write({
        acceptedUpdates: {
          ...current.acceptedUpdates,
          [kind]: accepted,
        },
      });
    },

    async completeUpdate(kind: string, updateId: number): Promise<void> {
      const current = await store.read();
      const accepted = (current.acceptedUpdates[kind] || []).filter((id) => id > updateId);
      await store.write({
        processedUpdates: {
          ...current.processedUpdates,
          [kind]: Math.max(current.processedUpdates[kind] || 0, updateId),
        },
        acceptedUpdates: {
          ...current.acceptedUpdates,
          [kind]: accepted,
        },
      });
    },
  };
}

export function createFileBridgeState(filePath: string) {
  const defaultValue: BridgeStateData = {
    processedUpdates: {},
    acceptedUpdates: {},
  };
  return createFileStore(filePath, defaultValue);
}
