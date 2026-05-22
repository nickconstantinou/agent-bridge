import { describe, expect, it } from "vitest";
import { escapeTelegramMarkdownV2, normalizeTelegramCodeFences, splitTelegramText, toTelegramEntitiesText } from "../src/render.js";

describe("escapeTelegramMarkdownV2", () => {
  it("escapes reserved characters in plain text", () => {
    expect(escapeTelegramMarkdownV2("Hello-world.!")).toBe("Hello\\-world\\.\\!");
  });

  it("does not escape the delimiter backticks of inline code", () => {
    expect(escapeTelegramMarkdownV2("`v1.0.0-beta`")).toBe("`v1.0.0-beta`");
    expect(escapeTelegramMarkdownV2("Fixed: `v1.0.0-beta`")).toBe("Fixed: `v1.0.0-beta`");
  });

  it("does not escape triple-backtick fences", () => {
    expect(escapeTelegramMarkdownV2("```\nconst x = 1-2;\n```")).toBe("```\nconst x = 1-2;\n```");
  });

  it("preserves bold and italic syntax while escaping content", () => {
    // This is the tricky one. "Smart" escaping.
    // *bold* -> *bold* (if we want to keep it bold)
    // But if the user says "I have * star", it should be "I have \* star"
    // Since we are bridging an agent, the agent likely uses *bold* intentionally.
    expect(escapeTelegramMarkdownV2("*bold text*")).toBe("*bold text*");
  });

  it("escapes orphaned markers that would cause Telegram parsing errors", () => {
    // Unbalanced * should be escaped
    expect(escapeTelegramMarkdownV2("This is *orphaned")).toBe("This is \\*orphaned");
    
    // Balanced should be kept
    expect(escapeTelegramMarkdownV2("*bold* and *balanced*")).toBe("*bold* and *balanced*");

    // Multiple orphaned
    expect(escapeTelegramMarkdownV2("*bold* and _italic and *bold")).toBe("*bold* and \\_italic and \\*bold");
  });
});

describe("normalizeTelegramCodeFences", () => {
  it("converts standalone triple single-quote fences to triple backticks", () => {
    const input = "Here is code:\n'''bash\necho hi\n'''";
    expect(normalizeTelegramCodeFences(input)).toBe("Here is code:\n```bash\necho hi\n```");
  });

  it("does not rewrite apostrophes inside prose", () => {
    const input = "That's Nick's bridge, and it isn't broken.";
    expect(normalizeTelegramCodeFences(input)).toBe(input);
  });

  it("lets entity rendering treat normalized fences as pre blocks", () => {
    const result = toTelegramEntitiesText(normalizeTelegramCodeFences("'''\nconst x = 1;\n'''"));
    expect(result.text).toBe("const x = 1;\n");
    expect(result.entities).toEqual([{ type: "pre", offset: 0, length: 13 }]);
  });

  it("lets chunk splitting see normalized code fences", () => {
    const chunks = splitTelegramText(normalizeTelegramCodeFences("'''\nhello\n'''"), 20);
    expect(chunks.join("\n")).toContain("```");
  });
});
