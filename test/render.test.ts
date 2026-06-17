import { describe, expect, it } from "vitest";
import { escapeTelegramMarkdownV2, toTelegramEntitiesText, renderTelegramEntitiesFromIR } from "../src/render.js";
import { parseMarkdownToIR } from "../src/markdownIR.js";

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

describe("toTelegramEntitiesText", () => {
  it("uses Telegram pre language metadata instead of showing the fence language", () => {
    const result = toTelegramEntitiesText("```ts\nconst x = 1;\n```");
    expect(result.text).toBe("const x = 1;\n");
    expect(result.entities).toEqual([{ type: "pre", offset: 0, length: 13, language: "ts" }]);
  });

  it("renders unlabeled fenced code blocks without language metadata", () => {
    const result = toTelegramEntitiesText("```\nconst x = 1;\n```");
    expect(result.text).toBe("const x = 1;\n");
    expect(result.entities).toEqual([{ type: "pre", offset: 0, length: 13 }]);
  });
});

describe("renderTelegramEntitiesFromIR", () => {
  const cases = [
    "Use a List<String> type here, not <Object>.",
    "Fetch & retry on 5xx, **respect** Retry-After.",
    "**a < b && c > d**",
    "✅ **Done** — 🚀 shipped to prod 🎉",
    "run `npm test` now",
    "### Section\nbody text",
    "plain text with no markup at all",
  ];

  it.each(cases)("matches toTelegramEntitiesText output for: %s", (input) => {
    const legacy = toTelegramEntitiesText(input);
    const ir = parseMarkdownToIR(input.replace(/^(#{1,3})\s+(.+)$/m, "$1 $2"));
    const next = renderTelegramEntitiesFromIR(ir);
    expect(next).toEqual(legacy);
  });

  it("renders a code block as a pre entity with language", () => {
    const ir = parseMarkdownToIR("```js\nconsole.log(1);\n```");
    expect(renderTelegramEntitiesFromIR(ir)).toEqual({
      text: "console.log(1);\n",
      entities: [{ type: "pre", offset: 0, length: 16, language: "js" }],
    });
  });

  it("returns empty text and entities for empty input", () => {
    expect(renderTelegramEntitiesFromIR([])).toEqual({ text: "", entities: [] });
  });

  it("renders an ordered list as numbered plain text", () => {
    const ir = parseMarkdownToIR("1. first\n2. second");
    expect(renderTelegramEntitiesFromIR(ir)).toEqual({
      text: "1. first\n2. second",
      entities: [],
    });
  });
});
