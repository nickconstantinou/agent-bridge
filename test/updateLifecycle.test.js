import { describe, expect, it } from "vitest";
import { createBridgeState, createMemoryBridgeState } from "../src/state.js";
import { processTelegramUpdate } from "../src/updateLifecycle.js";

describe("update lifecycle", () => {
  it("does not execute an accepted update again after delivery failure", async () => {
    const state = createBridgeState(createMemoryBridgeState());
    let executions = 0;

    await expect(processTelegramUpdate("codex", { update_id: 42 }, state, async () => {
      executions += 1;
      throw new Error("Telegram send failed");
    })).rejects.toThrow(/Telegram send failed/);

    await processTelegramUpdate("codex", { update_id: 42 }, state, async () => {
      executions += 1;
    });

    expect(executions).toBe(1);
    expect(await state.getProcessedUpdateId("codex")).toBe(42);
  });
});
