import { describe, expect, it } from "vitest";
import { splitTelegramText, renderTelegramPlainText, escapeTelegramMarkdownV2 } from "../src/render.js";

describe("render helpers", () => {
  it("splits long text on boundaries", () => {
    const text = `${"a".repeat(120)}\n\n${"b".repeat(120)}\n\n${"c".repeat(120)}`;
    const parts = splitTelegramText(text, 130);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toContain("a".repeat(120));
  });

  it("renders plain text safely", () => {
    expect(renderTelegramPlainText("  hello  ")).toBe("hello");
  });

  it("escapes markdown v2 metacharacters", () => {
    expect(escapeTelegramMarkdownV2("_ * [ ] ( ) ~ ` > # + - = | { } . ! \\")).toContain("\\_");
  });
});
