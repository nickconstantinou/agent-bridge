import { describe, it, expect } from "vitest";
import { parseWorkCallback, buildWorkCallback } from "../src/workCallbacks.js";

describe("work callback parser", () => {
  it("parses each valid callback format", () => {
    expect(parseWorkCallback("wi:123:view")).toEqual({ type: "wi_view", id: 123 });
    expect(parseWorkCallback("wi:456:appv")).toEqual({ type: "wi_appv", id: 456 });
    expect(parseWorkCallback("wi:789:clse")).toEqual({ type: "wi_clse", id: 789 });
    expect(parseWorkCallback("job:12:cncl")).toEqual({ type: "job_cncl", id: 12 });
    expect(parseWorkCallback("ap:34:yes")).toEqual({ type: "ap_yes", id: 34 });
    expect(parseWorkCallback("ap:56:no")).toEqual({ type: "ap_no", id: 56 });
  });

  it("rejectes unknown prefixes", () => {
    expect(parseWorkCallback("other:123:view")).toBeNull();
  });

  it("rejects unknown actions", () => {
    expect(parseWorkCallback("wi:123:other")).toBeNull();
  });

  it("rejects missing ids", () => {
    expect(parseWorkCallback("wi::view")).toBeNull();
  });

  it("rejects non-numeric ids", () => {
    expect(parseWorkCallback("wi:abc:view")).toBeNull();
  });

  it("rejects payloads over 64 bytes", () => {
    const longId = "9".repeat(60);
    expect(parseWorkCallback(`wi:${longId}:view`)).toBeNull();
  });
});

describe("work callback builder", () => {
  it("builds correct strings", () => {
    expect(buildWorkCallback({ type: "wi_view", id: 123 })).toBe("wi:123:view");
    expect(buildWorkCallback({ type: "wi_appv", id: 456 })).toBe("wi:456:appv");
    expect(buildWorkCallback({ type: "wi_clse", id: 789 })).toBe("wi:789:clse");
    expect(buildWorkCallback({ type: "job_cncl", id: 12 })).toBe("job:12:cncl");
    expect(buildWorkCallback({ type: "ap_yes", id: 34 })).toBe("ap:34:yes");
    expect(buildWorkCallback({ type: "ap_no", id: 56 })).toBe("ap:56:no");
  });

  it("throws or returns under 64 bytes", () => {
    const longId = 10 ** 15; // large number
    const result = buildWorkCallback({ type: "wi_view", id: longId });
    expect(result.length).toBeLessThanOrEqual(64);
  });
});
