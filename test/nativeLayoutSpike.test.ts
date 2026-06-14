import { describe, expect, it } from "vitest";
import {
  buildNativeHtmlDocumentPayload,
  buildNativeLayoutPayload,
  buildNativePhotoPayload,
  buildRichMessageDraftPayload,
  buildRichMessagePayload,
  countCodeBlocks,
  flattenMarkdownTablesToCards,
  hasMarkdownTable,
  richMessageProbeHtml,
  routeNativeLayout,
} from "../scripts/native-layout-spike.js";

describe("native layout spike helpers", () => {
  it("detects and flattens markdown tables into vertical HTML cards", () => {
    const input = [
      "| Service | Status | Latency | Owner |",
      "|---|---|---:|---|",
      "| web-api | healthy | 12ms | platform |",
      "| worker | degraded | 240ms | ops |",
    ].join("\n");

    expect(hasMarkdownTable(input)).toBe(true);
    const flattened = flattenMarkdownTablesToCards(input);

    expect(flattened).toContain("<b>Service:</b> web-api");
    expect(flattened).toContain("• <b>Status:</b> healthy");
    expect(flattened).toContain("• <b>Latency:</b> 12ms");
    expect(flattened).toContain("---");
    expect(flattened).not.toContain("| web-api |");
  });

  it("routes long or code-block-heavy responses to in-memory documents", () => {
    expect(routeNativeLayout("x".repeat(3_501)).kind).toBe("document");
    expect(routeNativeLayout("```a```\n```b```\n```c```\n```d```").kind).toBe("document");
    expect(routeNativeLayout("| A | B |\n|---|---|\n| 1 | 2 |").kind).toBe("html");
    expect(countCodeBlocks("```a```\nplain\n```b```")).toBe(2);
  });

  it("builds a response.md document payload from memory only", async () => {
    const payload = buildNativeLayoutPayload("x".repeat(3_501), "123");

    expect(payload.method).toBe("sendDocument");
    expect(payload.body).toBeInstanceOf(FormData);
    const file = (payload.body as FormData).get("document") as File;
    expect(file.name).toBe("response.md");
    expect(await file.text()).toBe("x".repeat(3_501));
  });

  it("builds a response.html document payload from native HTML in memory only", async () => {
    const payload = buildNativeHtmlDocumentPayload("<b>Service:</b> web-api", "123");

    expect(payload.method).toBe("sendDocument");
    expect(payload.body).toBeInstanceOf(FormData);
    const file = (payload.body as FormData).get("document") as File;
    expect(file.name).toBe("response.html");
    expect(file.type).toBe("text/html");
    expect(await file.text()).toContain("<!doctype html>");
    expect(await file.text()).toContain("<b>Service:</b> web-api");
  });

  it("builds an in-memory photo payload without requiring a temp file path", async () => {
    const payload = buildNativePhotoPayload(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "123");

    expect(payload.method).toBe("sendPhoto");
    const file = (payload.body as FormData).get("photo") as File;
    expect(file.name).toBe("response.png");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("builds Bot API 10.1 rich message table and details payloads", () => {
    const payload = buildRichMessagePayload("123");

    expect(payload.method).toBe("sendRichMessage");
    expect(payload.body).toEqual({
      chat_id: "123",
      rich_message: {
        html: richMessageProbeHtml,
      },
    });
    expect(richMessageProbeHtml).toContain("<table bordered striped>");
    expect(richMessageProbeHtml).toContain("<details open>");
    expect(richMessageProbeHtml).toContain("<pre><code class=\"language-text\">");
  });

  it("builds Bot API 10.1 rich message draft payloads", () => {
    const payload = buildRichMessageDraftPayload("123", 42, "<tg-thinking>Thinking</tg-thinking>");

    expect(payload.method).toBe("sendRichMessageDraft");
    expect(payload.body).toEqual({
      chat_id: "123",
      draft_id: 42,
      rich_message: {
        html: "<tg-thinking>Thinking</tg-thinking>",
      },
    });
  });
});
