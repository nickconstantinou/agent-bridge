import { describe, expect, it } from "vitest";
import { toTelegramEntitiesText } from "../src/render.js";

describe("toTelegramEntitiesText repro", () => {
  it("converts ### heading to bold", () => {
    const input = "### Hello World";
    const result = toTelegramEntitiesText(input);
    expect(result.text).toContain("Hello World");
    expect(result.entities.some(e => e.type === "bold")).toBe(true);
  });

  it("converts ## heading to bold", () => {
    const input = "## Section";
    const result = toTelegramEntitiesText(input);
    expect(result.text).toContain("Section");
    expect(result.entities.some(e => e.type === "bold")).toBe(true);
  });

  it("converts # heading to bold", () => {
    const input = "# Title";
    const result = toTelegramEntitiesText(input);
    expect(result.text).toContain("Title");
    expect(result.entities.some(e => e.type === "bold")).toBe(true);
  });
});
