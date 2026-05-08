import { describe, expect, it, vi } from "vitest";
import { createTelegramMessageProgress } from "../src/messageProgress.js";

describe("telegram message progress", () => {
  it("coalesces rapid updates into throttled edits", async () => {
    vi.useFakeTimers();
    const calls = [];
    const progress = createTelegramMessageProgress({ minEditIntervalMs: 1000 });
    const send = async (body) => {
      calls.push({ ...body });
    };

    await progress.update({ chat_id: 1, message_id: 2, text: "a" }, send);
    await progress.update({ chat_id: 1, message_id: 2, text: "ab" }, send);
    await progress.update({ chat_id: 1, message_id: 2, text: "abc" }, send);
    await vi.advanceTimersByTimeAsync(1000);
    await progress.flush();

    expect(calls).toEqual([{ chat_id: 1, message_id: 2, text: "abc" }]);
    vi.useRealTimers();
  });
});
