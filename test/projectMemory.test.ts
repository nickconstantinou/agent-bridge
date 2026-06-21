import { describe, expect, it } from "vitest";
import { extractProjectMemorySidecars } from "../src/projectMemory.js";

describe("project memory sidecar extraction", () => {
  it("does not strip sidecar examples inside fenced code blocks", () => {
    const text = [
      "Use this format:",
      "",
      "```html",
      "<!-- agent-bridge-memory",
      JSON.stringify([{ type: "decision", scope: "project", text: "Example only, do not store." }]),
      "-->",
      "```",
      "",
      "End.",
    ].join("\n");

    const extracted = extractProjectMemorySidecars(text);

    expect(extracted.cleanText).toContain("agent-bridge-memory");
    expect(extracted.candidates).toEqual([]);
  });
});
