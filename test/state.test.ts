import { describe, expect, it } from "vitest";
import { createBridgeState } from "../src/state.js";
import { createMemoryStore } from "../src/store.js";
import type { BridgeStateData } from "../src/types.js";

describe("Bridge State", () => {
  it("tracks and completes updates", async () => {
    const store = createMemoryStore<BridgeStateData>({
      processedUpdates: {},
      acceptedUpdates: {},
    });
    const state = createBridgeState(store);

    expect(await state.getProcessedUpdateId("codex")).toBe(0);
    expect(await state.isUpdateAccepted("codex", 100)).toBe(false);

    await state.acceptUpdate("codex", 100);
    expect(await state.isUpdateAccepted("codex", 100)).toBe(true);

    await state.completeUpdate("codex", 100);
    expect(await state.getProcessedUpdateId("codex")).toBe(100);
    expect(await state.isUpdateAccepted("codex", 100)).toBe(false);
  });
});
