import { describe, expect, it } from "vitest";
import {
  createTelegraphPage,
  markdownToTelegraphNodes,
  shouldUseInstantView,
  stripAnsi,
  type TelegraphNode,
} from "../scripts/telegraph-spike.js";

describe("stripAnsi", () => {
  it("removes ANSI color codes from terminal output", () => {
    expect(stripAnsi("\x1b[32mgreen\x1b[0m")).toBe("green");
    expect(stripAnsi("\x1b[1;31mbold red\x1b[0m")).toBe("bold red");
  });

  it("leaves plain text unchanged", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });

  it("removes cursor movement and erase codes", () => {
    expect(stripAnsi("\x1b[2J\x1b[H\x1b[?25l text")).toBe(" text");
  });
});

describe("markdownToTelegraphNodes — inline formatting", () => {
  it("wraps **bold** in strong tags", () => {
    const nodes = markdownToTelegraphNodes("**hello world**");
    expect(nodes).toContainEqual(
      expect.objectContaining({ tag: "p", children: expect.arrayContaining([
        expect.objectContaining({ tag: "strong", children: ["hello world"] }),
      ]) }),
    );
  });

  it("wraps _italic_ in em tags", () => {
    const nodes = markdownToTelegraphNodes("_italic text_");
    expect(nodes).toContainEqual(
      expect.objectContaining({ tag: "p", children: expect.arrayContaining([
        expect.objectContaining({ tag: "em", children: ["italic text"] }),
      ]) }),
    );
  });

  it("wraps `inline code` in code tags", () => {
    const nodes = markdownToTelegraphNodes("Use `npm test` here");
    const p = nodes.find((n): n is TelegraphNode & { tag: string } => typeof n === "object" && (n as any).tag === "p");
    expect(p).toBeDefined();
    expect((p as any).children).toContainEqual(
      expect.objectContaining({ tag: "code", children: ["npm test"] }),
    );
  });
});

describe("markdownToTelegraphNodes — block elements", () => {
  it("converts # heading to h3", () => {
    const nodes = markdownToTelegraphNodes("# Main Title");
    expect(nodes).toContainEqual(
      expect.objectContaining({ tag: "h3", children: ["Main Title"] }),
    );
  });

  it("converts #### heading to h4", () => {
    const nodes = markdownToTelegraphNodes("#### Sub Title");
    expect(nodes).toContainEqual(
      expect.objectContaining({ tag: "h4", children: ["Sub Title"] }),
    );
  });

  it("wraps fenced code blocks in pre > code", () => {
    const nodes = markdownToTelegraphNodes("```bash\nnpm test\n```");
    const pre = nodes.find((n): n is TelegraphNode & { tag: string } => typeof n === "object" && (n as any).tag === "pre");
    expect(pre).toBeDefined();
    expect((pre as any).children).toContainEqual(
      expect.objectContaining({ tag: "code", children: ["npm test"] }),
    );
  });

  it("converts unordered list to ul > li nodes", () => {
    const nodes = markdownToTelegraphNodes("- alpha\n- beta\n- gamma");
    const ul = nodes.find((n): n is TelegraphNode & { tag: string } => typeof n === "object" && (n as any).tag === "ul");
    expect(ul).toBeDefined();
    const children = (ul as any).children as TelegraphNode[];
    expect(children).toHaveLength(3);
    expect(children[0]).toMatchObject({ tag: "li" });
  });

  it("converts ordered list to ol > li nodes", () => {
    const nodes = markdownToTelegraphNodes("1. first\n2. second");
    const ol = nodes.find((n): n is TelegraphNode & { tag: string } => typeof n === "object" && (n as any).tag === "ol");
    expect(ol).toBeDefined();
    expect(((ol as any).children as TelegraphNode[])).toHaveLength(2);
  });

  it("converts markdown tables to a preformatted block", () => {
    const table = "| A | B |\n|---|---|\n| 1 | 2 |";
    const nodes = markdownToTelegraphNodes(table);
    const pre = nodes.find((n): n is TelegraphNode & { tag: string } => typeof n === "object" && (n as any).tag === "pre");
    expect(pre).toBeDefined();
  });

  it("converts --- to hr", () => {
    const nodes = markdownToTelegraphNodes("---");
    expect(nodes).toContainEqual(expect.objectContaining({ tag: "hr" }));
  });

  it("wraps plain text in p tags", () => {
    const nodes = markdownToTelegraphNodes("Just a sentence.");
    expect(nodes).toContainEqual(
      expect.objectContaining({ tag: "p" }),
    );
  });

  it("strips ANSI codes before converting", () => {
    const nodes = markdownToTelegraphNodes("\x1b[32m**green bold**\x1b[0m");
    expect(nodes).toContainEqual(
      expect.objectContaining({ tag: "p", children: expect.arrayContaining([
        expect.objectContaining({ tag: "strong" }),
      ]) }),
    );
  });
});

describe("shouldUseInstantView", () => {
  it("returns false for short plain replies", () => {
    expect(shouldUseInstantView("Short reply.")).toBe(false);
  });

  it("returns true when text exceeds 1500 characters", () => {
    expect(shouldUseInstantView("x".repeat(1501))).toBe(true);
  });

  it("returns true when text contains a markdown table", () => {
    expect(shouldUseInstantView("| A | B |\n|---|---|\n| 1 | 2 |")).toBe(true);
  });

  it("returns true when text contains multiple code blocks", () => {
    const text = "```\nfoo\n```\n\nsome text\n\n```\nbar\n```";
    expect(shouldUseInstantView(text)).toBe(true);
  });
});

describe("createTelegraphPage", () => {
  it("calls createAccount then createPage and returns the page URL", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const mockFetch = async (url: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body));
      requests.push({ url, body });
      if (url.includes("createAccount")) {
        return new Response(JSON.stringify({ ok: true, result: { access_token: "tok123" } }));
      }
      if (url.includes("createPage")) {
        return new Response(JSON.stringify({ ok: true, result: { url: "https://telegra.ph/test-06-14" } }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const url = await createTelegraphPage({
      title: "Test Page",
      markdown: "# Hello\n\nWorld.",
      fetchFn: mockFetch as typeof fetch,
    });

    expect(url).toBe("https://telegra.ph/test-06-14");
    expect(requests[0]?.url).toContain("createAccount");
    expect(requests[1]?.url).toContain("createPage");
    expect(requests[1]?.body).toMatchObject({ access_token: "tok123", title: "Test Page" });
  });

  it("throws when the Telegraph API returns ok: false", async () => {
    const mockFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ ok: false, error: "FLOOD_WAIT" }));

    await expect(
      createTelegraphPage({ title: "T", markdown: "x", fetchFn: mockFetch as typeof fetch }),
    ).rejects.toThrow("FLOOD_WAIT");
  });
});
