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
