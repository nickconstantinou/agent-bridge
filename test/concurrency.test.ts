import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "../src/concurrency.js";

describe("mapWithConcurrency", () => {
  it("preserves result order regardless of completion order", async () => {
    const results = await mapWithConcurrency(
      [30, 10, 20],
      3,
      (ms) => new Promise<number>((resolve) => setTimeout(() => resolve(ms), ms)),
    );
    expect(results).toEqual([30, 10, 20]);
  });

  it("never runs more than `limit` items concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });
    expect(maxActive).toBe(2);
  });

  it("returns an empty array for empty input", async () => {
    const results = await mapWithConcurrency([], 3, async (x) => x);
    expect(results).toEqual([]);
  });

  it("clamps concurrency to the item count when limit exceeds it", async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency([1, 2], 10, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });
    expect(maxActive).toBe(2);
  });
});
