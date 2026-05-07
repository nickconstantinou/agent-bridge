import { createFileStore, createMemoryStore } from "./store.js";

export function createMemoryBridgeState(initial = {}) {
  return createMemoryStore({
    processedUpdates: { codex: 0, gemini: 0 },
    acceptedUpdates: { codex: [], gemini: [] },
    ...initial,
  });
}

export function createFileBridgeState(filePath) {
  return createFileStore(filePath, { processedUpdates: { codex: 0, gemini: 0 }, acceptedUpdates: { codex: [], gemini: [] } });
}

export function createBridgeState(store = createMemoryBridgeState()) {
  return {
    async read() {
      return normalizeState(await store.read());
    },
    async getProcessedUpdateId(kind) {
      const data = await this.read();
      return data.processedUpdates?.[kind] ?? 0;
    },
    async setProcessedUpdateId(kind, updateId) {
      const current = await this.read();
      await store.write({
        ...current,
        processedUpdates: {
          ...(current.processedUpdates || {}),
          [kind]: updateId,
        },
      });
    },
    async hasAcceptedUpdate(kind, updateId) {
      const current = await this.read();
      return current.processedUpdates?.[kind] >= updateId || current.acceptedUpdates?.[kind]?.includes(updateId);
    },
    async acceptUpdate(kind, updateId) {
      const current = await this.read();
      const existing = current.acceptedUpdates?.[kind] || [];
      const accepted = existing.includes(updateId) ? existing : [...existing, updateId].slice(-100);
      await store.write({
        ...current,
        acceptedUpdates: {
          ...(current.acceptedUpdates || {}),
          [kind]: accepted,
        },
      });
    },
    async completeUpdate(kind, updateId) {
      const current = await this.read();
      const accepted = (current.acceptedUpdates?.[kind] || []).filter((id) => id > updateId);
      await store.write({
        ...current,
        processedUpdates: {
          ...(current.processedUpdates || {}),
          [kind]: Math.max(current.processedUpdates?.[kind] || 0, updateId),
        },
        acceptedUpdates: {
          ...(current.acceptedUpdates || {}),
          [kind]: accepted,
        },
      });
    },
  };
}

function normalizeState(data) {
  const processedUpdates = data?.processedUpdates ?? {};
  const safeCodex = Number.isFinite(processedUpdates.codex) && processedUpdates.codex >= 0 ? processedUpdates.codex : 0;
  const safeGemini = Number.isFinite(processedUpdates.gemini) && processedUpdates.gemini >= 0 ? processedUpdates.gemini : 0;
  return {
    ...data,
    processedUpdates: {
      codex: safeCodex,
      gemini: safeGemini,
    },
    acceptedUpdates: {
      codex: Array.isArray(data?.acceptedUpdates?.codex) ? data.acceptedUpdates.codex.filter(Number.isFinite) : [],
      gemini: Array.isArray(data?.acceptedUpdates?.gemini) ? data.acceptedUpdates.gemini.filter(Number.isFinite) : [],
    },
  };
}
