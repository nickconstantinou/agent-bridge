import { describe, it, expect } from "vitest";
import { parseMarkdownToIR } from "../src/markdownIR.js";

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
});
