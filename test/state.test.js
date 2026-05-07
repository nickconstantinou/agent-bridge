import { describe, expect, it } from "vitest";
import { createBridgeState, createMemoryBridgeState } from "../src/state.js";

describe("bridge state", () => {
  it("tracks processed updates for each bot", async () => {
    const state = createBridgeState(createMemoryBridgeState());
    expect(await state.getProcessedUpdateId("codex")).toBe(0);
    expect(await state.getProcessedUpdateId("gemini")).toBe(0);

    await state.setProcessedUpdateId("codex", 100);
    expect(await state.getProcessedUpdateId("codex")).toBe(100);
    expect(await state.getProcessedUpdateId("gemini")).toBe(0);

    await state.setProcessedUpdateId("gemini", 200);
    expect(await state.getProcessedUpdateId("codex")).toBe(100);
    expect(await state.getProcessedUpdateId("gemini")).toBe(200);
  });

  it("can read full state", async () => {
    const state = createBridgeState(createMemoryBridgeState());
    await state.setProcessedUpdateId("codex", 100);
    const data = await state.read();
    expect(data.processedUpdates.codex).toBe(100);
  });

  it("tracks accepted updates separately from completed updates", async () => {
    const state = createBridgeState(createMemoryBridgeState());
    expect(await state.hasAcceptedUpdate("codex", 100)).toBe(false);
    await state.acceptUpdate("codex", 100);
    expect(await state.hasAcceptedUpdate("codex", 100)).toBe(true);
    expect(await state.getProcessedUpdateId("codex")).toBe(0);
    await state.completeUpdate("codex", 100);
    expect(await state.getProcessedUpdateId("codex")).toBe(100);
  });

  it("heals invalid cursors to zero", async () => {
    const state = createBridgeState(createMemoryBridgeState({ processedUpdates: { codex: -99, gemini: Number.NaN } }));
    expect(await state.getProcessedUpdateId("codex")).toBe(0);
    expect(await state.getProcessedUpdateId("gemini")).toBe(0);
  });
});
