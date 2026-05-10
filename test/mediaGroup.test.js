import { describe, expect, it, vi } from "vitest";
import { MediaGroupBuffer } from "../src/telegram.js";

describe("MediaGroupBuffer", () => {
  it("aggregates messages with the same media_group_id", async () => {
    const onFlush = vi.fn();
    const buffer = new MediaGroupBuffer({ timeoutMs: 100, onFlush });

    buffer.push({ message_id: 1, media_group_id: "group1", text: "photo 1" });
    buffer.push({ message_id: 2, media_group_id: "group1", text: "photo 2" });
    
    // Wait for group1 to start its timer, then push group2 much later
    await new Promise(r => setTimeout(r, 50));
    buffer.push({ message_id: 3, media_group_id: "group2", text: "photo 3" });

    // Wait for group1 to flush (100ms total from start, we are at 50ms, so 70ms more)
    await new Promise(r => setTimeout(r, 70));

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith("group1", [
      expect.objectContaining({ message_id: 1 }),
      expect.objectContaining({ message_id: 2 }),
    ]);

    // Wait for group2 to flush (100ms from its push at T=50ms, we are at T=120ms, so 50ms more)
    await new Promise(r => setTimeout(r, 50));
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenCalledWith("group2", [
      expect.objectContaining({ message_id: 3 }),
    ]);
  });

  it("does not include new messages in a flush whose timer has already fired", async () => {
    const flushArgs = [];
    let resolveFlush;

    const buffer = new MediaGroupBuffer({
      timeoutMs: 50,
      onFlush: async (groupId, messages) => {
        flushArgs.push({ groupId, ids: messages.map((m) => m.message_id) });
        if (flushArgs.length === 1) await new Promise((r) => { resolveFlush = r; });
      },
    });

    buffer.push({ message_id: 1, media_group_id: "g" });
    await new Promise((r) => setTimeout(r, 70)); // timer fires, async flush starts

    // New message arrives while first flush is awaiting
    buffer.push({ message_id: 2, media_group_id: "g" });

    resolveFlush(); // release first flush
    await new Promise((r) => setTimeout(r, 100)); // wait for second flush

    expect(flushArgs).toHaveLength(2);
    expect(flushArgs[0].ids).toEqual([1]);
    expect(flushArgs[1].ids).toEqual([2]);
  });

  it("does not propagate an unhandled rejection when onFlush rejects", async () => {
    const buffer = new MediaGroupBuffer({
      timeoutMs: 50,
      onFlush: async () => {
        throw new Error("flush failed");
      },
    });

    buffer.push({ message_id: 1, media_group_id: "g" });
    // If onFlush rejection is unhandled, vitest will detect and fail this test.
    await new Promise((r) => setTimeout(r, 150));
    // Reaching here means the rejection was handled internally.
  });

  it("resets timeout on subsequent messages in the same group", async () => {
    const onFlush = vi.fn();
    const buffer = new MediaGroupBuffer({ timeoutMs: 100, onFlush });

    buffer.push({ message_id: 1, media_group_id: "group1" });
    await new Promise(r => setTimeout(r, 50));
    buffer.push({ message_id: 2, media_group_id: "group1" });
    await new Promise(r => setTimeout(r, 70));
    
    expect(onFlush).not.toHaveBeenCalled();

    await new Promise(r => setTimeout(r, 50));
    expect(onFlush).toHaveBeenCalledTimes(1);
  });
});
