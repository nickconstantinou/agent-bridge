import { describe, expect, it } from "vitest";
import { escapeTelegramMarkdownV2 } from "../src/render.js";

describe("escapeTelegramMarkdownV2", () => {
  it("escapes reserved characters in plain text", () => {
    expect(escapeTelegramMarkdownV2("Hello-world.!")).toBe("Hello\\-world\\.\\!");
  });

  it("escapes backticks inside code blocks as required by Telegram", () => {
    const text = "Fixed: `v1.0.0-beta`";
    // Telegram V2 docs: "Inside pre and code entities, all '`', and '\' characters must be escaped"
    // BUT the wrapping backticks themselves should probably NOT be escaped if they are delimiters.
    // My implementation is currently escaping the delimiters because they are part of the 'part'.
    expect(escapeTelegramMarkdownV2(text)).toBe("Fixed: \\`v1.0.0-beta\\`");
  });

  it("escapes backticks inside triple backtick blocks", () => {
    const text = "Check this:\n```\nconst x = 1-2;\n```";
    expect(escapeTelegramMarkdownV2(text)).toBe("Check this:\n\\`\\`\\`\nconst x = 1-2;\n\\`\\`\\`");
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
