import { describe, it, expect } from "vitest";
import {
  parseMarkdownToIR,
  renderMarkerString,
  DISCORD_MARKERS,
  TELEGRAM_HTML_MARKERS,
  discordMarkdownIrEnabled,
  telegramMarkdownIrEnabled,
} from "../src/markdownIR.js";

describe("parseMarkdownToIR", () => {
  it("parses plain text with no markup", () => {
    expect(parseMarkdownToIR("hello world")).toEqual([
      { type: "text", value: "hello world" },
    ]);
  });

  it("parses a bold span", () => {
    expect(parseMarkdownToIR("**Done**")).toEqual([
      { type: "bold", value: "Done" },
    ]);
  });

  it("parses text surrounding a bold span", () => {
    expect(parseMarkdownToIR("✅ **Done** — shipped")).toEqual([
      { type: "text", value: "✅ " },
      { type: "bold", value: "Done" },
      { type: "text", value: " — shipped" },
    ]);
  });

  it("parses an inline code span", () => {
    expect(parseMarkdownToIR("run `npm test` now")).toEqual([
      { type: "text", value: "run " },
      { type: "code_inline", value: "npm test" },
      { type: "text", value: " now" },
    ]);
  });

  it("treats an unmatched ** as plain text", () => {
    expect(parseMarkdownToIR("a ** b")).toEqual([
      { type: "text", value: "a ** b" },
    ]);
  });

  it("joins multiple plain lines into one paragraph with embedded newlines", () => {
    expect(parseMarkdownToIR("line one\nline two")).toEqual([
      { type: "text", value: "line one\nline two" },
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseMarkdownToIR("")).toEqual([]);
  });

  it("parses a code block with a language tag", () => {
    expect(parseMarkdownToIR("```js\nconsole.log(1);\n```")).toEqual([
      { type: "code_block", value: "console.log(1);", language: "js" },
    ]);
  });

  it("parses a code block with no language tag", () => {
    expect(parseMarkdownToIR("```\nplain content\n```")).toEqual([
      { type: "code_block", value: "plain content", language: undefined },
    ]);
  });

  it("preserves angle brackets and ampersands inside a code block untouched", () => {
    expect(parseMarkdownToIR('```js\nif (x < 1 && y > 2) { log("<b>hi</b>"); }\n```')).toEqual([
      { type: "code_block", value: 'if (x < 1 && y > 2) { log("<b>hi</b>"); }', language: "js" },
    ]);
  });

  it("treats text before and after a code block as separate paragraphs", () => {
    expect(parseMarkdownToIR("before\n```\ncode\n```\nafter")).toEqual([
      { type: "text", value: "before" },
      { type: "code_block", value: "code", language: undefined },
      { type: "text", value: "after" },
    ]);
  });

  it("parses a level-1 heading", () => {
    expect(parseMarkdownToIR("# Title")).toEqual([
      { type: "heading", level: 1, value: "Title" },
    ]);
  });

  it("parses a level-3 heading", () => {
    expect(parseMarkdownToIR("### Sub Title")).toEqual([
      { type: "heading", level: 3, value: "Sub Title" },
    ]);
  });

  it("treats a heading and following paragraph as separate nodes", () => {
    expect(parseMarkdownToIR("## Section\nbody text")).toEqual([
      { type: "heading", level: 2, value: "Section" },
      { type: "text", value: "body text" },
    ]);
  });

  it("parses a markdown table", () => {
    const markdown = "| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |";
    expect(parseMarkdownToIR(markdown)).toEqual([
      {
        type: "table",
        headers: ["Name", "Age"],
        rows: [["Alice", "30"], ["Bob", "25"]],
      },
    ]);
  });

  it("does not treat a lone pipe-containing line without a separator as a table", () => {
    expect(parseMarkdownToIR("a | b")).toEqual([
      { type: "text", value: "a | b" },
    ]);
  });

  it("treats text before and after a table as separate paragraphs", () => {
    const markdown = "summary:\n| A | B |\n| --- | --- |\n| 1 | 2 |\nend.";
    expect(parseMarkdownToIR(markdown)).toEqual([
      { type: "text", value: "summary:" },
      { type: "table", headers: ["A", "B"], rows: [["1", "2"]] },
      { type: "text", value: "end." },
    ]);
  });

  it("parses a bullet list using -", () => {
    expect(parseMarkdownToIR("- first\n- second")).toEqual([
      { type: "list", items: ["first", "second"] },
    ]);
  });

  it("parses a bullet list using *", () => {
    expect(parseMarkdownToIR("* first\n* second")).toEqual([
      { type: "list", items: ["first", "second"] },
    ]);
  });

  it("treats text before and after a list as separate paragraphs", () => {
    expect(parseMarkdownToIR("intro\n- one\n- two\noutro")).toEqual([
      { type: "text", value: "intro" },
      { type: "list", items: ["one", "two"] },
      { type: "text", value: "outro" },
    ]);
  });
});

describe("renderMarkerString with DISCORD_MARKERS", () => {
  it("renders bold, code, and plain text", () => {
    const ir = parseMarkdownToIR("✅ **Done** — `npm test` passed");
    expect(renderMarkerString(ir, DISCORD_MARKERS)).toBe("✅ **Done** — `npm test` passed");
  });

  it("renders a code block with language fence", () => {
    const ir = parseMarkdownToIR("```js\nconsole.log(1);\n```");
    expect(renderMarkerString(ir, DISCORD_MARKERS)).toBe("```js\nconsole.log(1);\n```");
  });

  it("renders a heading using a # prefix", () => {
    const ir = parseMarkdownToIR("## Section");
    expect(renderMarkerString(ir, DISCORD_MARKERS)).toBe("## Section");
  });

  it("renders a list using - bullets", () => {
    const ir = parseMarkdownToIR("- one\n- two");
    expect(renderMarkerString(ir, DISCORD_MARKERS)).toBe("- one\n- two");
  });

  it("renders a table as a bold-label card list", () => {
    const ir = parseMarkdownToIR("| Name | Age |\n| --- | --- |\n| Alice | 30 |");
    expect(renderMarkerString(ir, DISCORD_MARKERS)).toBe("**Name:** Alice\n- **Age:** 30");
  });
});

describe("renderMarkerString with TELEGRAM_HTML_MARKERS", () => {
  it("escapes and bolds text", () => {
    const ir = parseMarkdownToIR("**a < b && c > d**");
    expect(renderMarkerString(ir, TELEGRAM_HTML_MARKERS)).toBe("<b>a &lt; b &amp;&amp; c &gt; d</b>");
  });

  it("renders a code block wrapped in <pre>, escaped", () => {
    const ir = parseMarkdownToIR("```\nif (x < 1) {}\n```");
    expect(renderMarkerString(ir, TELEGRAM_HTML_MARKERS)).toBe("<pre>if (x &lt; 1) {}</pre>");
  });

  it("renders a table as escaped bold-label cards", () => {
    const ir = parseMarkdownToIR("| Name | Age |\n| --- | --- |\n| Alice | 30 |");
    expect(renderMarkerString(ir, TELEGRAM_HTML_MARKERS)).toBe("<b>Name:</b> Alice\n• <b>Age:</b> 30");
  });
});

describe("feature flags", () => {
  it("discordMarkdownIrEnabled defaults to false", () => {
    delete process.env.DISCORD_MARKDOWN_IR_ENABLED;
    expect(discordMarkdownIrEnabled()).toBe(false);
  });

  it("discordMarkdownIrEnabled is true when env var is 'true'", () => {
    process.env.DISCORD_MARKDOWN_IR_ENABLED = "true";
    expect(discordMarkdownIrEnabled()).toBe(true);
    delete process.env.DISCORD_MARKDOWN_IR_ENABLED;
  });

  it("telegramMarkdownIrEnabled defaults to false", () => {
    delete process.env.TELEGRAM_MARKDOWN_IR_ENABLED;
    expect(telegramMarkdownIrEnabled()).toBe(false);
  });

  it("telegramMarkdownIrEnabled is true when env var is 'true'", () => {
    process.env.TELEGRAM_MARKDOWN_IR_ENABLED = "true";
    expect(telegramMarkdownIrEnabled()).toBe(true);
    delete process.env.TELEGRAM_MARKDOWN_IR_ENABLED;
  });
});
