import { describe, expect, it, vi } from "vitest";
import { processTelegramUpdate } from "../src/updateLifecycle.js";
import { createBridgeState } from "../src/state.js";
import { createMemoryStore } from "../src/store.js";
import type { BridgeStateData } from "../src/types.js";

describe("Update Lifecycle", () => {
  it("deduplicates updates", async () => {
    const store = createMemoryStore<BridgeStateData>({
      processedUpdates: { codex: 50 },
      acceptedUpdates: {},
    });
    const bridgeState = createBridgeState(store);
    const handleUpdate = vi.fn();

    // Already processed
    await processTelegramUpdate("codex", { update_id: 40 }, bridgeState, handleUpdate);
    expect(handleUpdate).not.toHaveBeenCalled();

    // New update
    await processTelegramUpdate("codex", { update_id: 100 }, bridgeState, handleUpdate);
    expect(handleUpdate).toHaveBeenCalledTimes(1);

    // Re-processing (simulated crash)
    await bridgeState.acceptUpdate("codex", 101);
    await processTelegramUpdate("codex", { update_id: 101 }, bridgeState, handleUpdate);
    expect(handleUpdate).toHaveBeenCalledTimes(1); // not incremented
  });
});
