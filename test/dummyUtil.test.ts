import { describe, expect, it } from "vitest";
import { isPositive } from "../src/dummyUtil";

describe("isPositive", () => {
  it("should return true for positive numbers", () => {
    expect(isPositive(5)).toBe(true);
    expect(isPositive(0.1)).toBe(true);
  });

  it("should return false for zero", () => {
    expect(isPositive(0)).toBe(false);
  });

  it("should return false for negative numbers", () => {
    expect(isPositive(-5)).toBe(false);
    expect(isPositive(-0.1)).toBe(false);
  });
});
