/**
 * Native Telegram layout spike.
 *
 * Isolated prototype for table flattening, HTML payload generation, and
 * in-memory Markdown document fallback. This file is intentionally separate
 * from production message routing.
 */

export type NativeLayoutRoute =
  | { kind: "document"; reason: "length" | "code_blocks"; codeBlocks: number; length: number }
  | { kind: "html"; reason: "table" | "default"; codeBlocks: number; length: number };

export type NativeLayoutPayload = {
  method: "sendMessage" | "sendDocument" | "sendPhoto" | "sendRichMessage" | "sendRichMessageDraft";
  body: FormData | Record<string, unknown>;
};

export const DOCUMENT_LENGTH_THRESHOLD = 3_500;
export const DOCUMENT_CODE_BLOCK_THRESHOLD = 3;

const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function countCodeBlocks(markdown: string): number {
  return markdown.match(/```/g)?.length ? Math.floor((markdown.match(/```/g) ?? []).length / 2) : 0;
}

export function hasMarkdownTable(markdown: string): boolean {
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (isTableRow(lines[i]) && TABLE_SEPARATOR_RE.test(lines[i + 1])) return true;
  }
  return false;
}

export function flattenMarkdownTablesToCards(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const output: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!isTableRow(lines[i]) || !TABLE_SEPARATOR_RE.test(lines[i + 1] ?? "")) {
      output.push(escapeHtml(lines[i]));
      continue;
    }

    const headers = splitTableRow(lines[i]);
    i += 2; // skip header + separator
    const rows: string[][] = [];
    while (i < lines.length && isTableRow(lines[i])) {
      rows.push(splitTableRow(lines[i]));
      i += 1;
    }
    i -= 1;

    for (const row of rows) {
      const [firstHeader, ...remainingHeaders] = headers;
      const [firstCell, ...remainingCells] = row;
      output.push(`<b>${escapeHtml(firstHeader ?? "Item")}:</b> ${escapeHtml(firstCell ?? "")}`);
      for (let c = 0; c < remainingHeaders.length; c += 1) {
        output.push(`• <b>${escapeHtml(remainingHeaders[c] ?? `Field ${c + 2}`)}:</b> ${escapeHtml(remainingCells[c] ?? "")}`);
      }
      output.push("---");
    }
  }

  return output.join("\n").replace(/\n---$/, "");
}

export function markdownToNativeHtml(markdown: string): string {
  if (hasMarkdownTable(markdown)) return flattenMarkdownTablesToCards(markdown);
  return escapeHtml(markdown);
}

export function routeNativeLayout(markdown: string): NativeLayoutRoute {
  const codeBlocks = countCodeBlocks(markdown);
  const length = markdown.length;
  if (length > DOCUMENT_LENGTH_THRESHOLD) return { kind: "document", reason: "length", codeBlocks, length };
  if (codeBlocks > DOCUMENT_CODE_BLOCK_THRESHOLD) return { kind: "document", reason: "code_blocks", codeBlocks, length };
  if (hasMarkdownTable(markdown)) return { kind: "html", reason: "table", codeBlocks, length };
  return { kind: "html", reason: "default", codeBlocks, length };
}

export function buildNativeLayoutPayload(markdown: string, chatId: string | number): NativeLayoutPayload {
  const route = routeNativeLayout(markdown);
  if (route.kind === "document") {
    const body = new FormData();
    body.set("chat_id", String(chatId));
    body.set("caption", `Full response attached as response.md (${route.reason})`);
    body.set("document", new File([Buffer.from(markdown, "utf8")], "response.md", { type: "text/markdown" }));
    return { method: "sendDocument", body };
  }

  return {
    method: "sendMessage",
    body: {
      chat_id: String(chatId),
      text: markdownToNativeHtml(markdown),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    },
  };
}

export function buildNativeHtmlDocumentPayload(nativeHtml: string, chatId: string | number): NativeLayoutPayload {
  const documentHtml = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Agent Response</title>",
    "</head>",
    "<body>",
    "<main>",
    nativeHtml,
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");
  const body = new FormData();
  body.set("chat_id", String(chatId));
  body.set("caption", "Full response attached as response.html");
  body.set("document", new File([Buffer.from(documentHtml, "utf8")], "response.html", { type: "text/html" }));
  return { method: "sendDocument", body };
}

export function buildNativePhotoPayload(
  imageBytes: Buffer,
  chatId: string | number,
  filename = "response.png",
  caption = "Rendered response preview",
): NativeLayoutPayload {
  const body = new FormData();
  body.set("chat_id", String(chatId));
  body.set("caption", caption);
  body.set("photo", new File([imageBytes], filename, { type: "image/png" }));
  return { method: "sendPhoto", body };
}

export const richMessageProbeHtml = [
  "<h2>Agent Bridge Rich Message Probe</h2>",
  '<p><b>Goal:</b> validate Bot API 10.1 rich tables, collapsible diagnostics, and code blocks without external rendering.</p>',
  "<table bordered striped><caption>Bridge service health</caption>",
  "<tr><th>Service</th><th>Status</th><th>Latency</th><th>Owner</th></tr>",
  '<tr><td>web-api</td><td><b>healthy</b></td><td align="right">12ms</td><td>platform</td></tr>',
  '<tr><td>queue</td><td><i>amber</i></td><td align="right">240ms</td><td>ops</td></tr>',
  '<tr><td>telegram-router</td><td><b>healthy</b></td><td align="right">31ms</td><td>bridge</td></tr>',
  "</table>",
  "<details open><summary>Diagnostics</summary>",
  "<p>Classic <code>sendMessage</code> cannot render this table; rich messages should.</p>",
  '<pre><code class="language-text">route=rich-message\nfallback=html-document\nsafe=true</code></pre>',
  "</details>",
  "<blockquote>Expected result: native table plus expandable diagnostics. Fallback remains flattened HTML cards.</blockquote>",
].join("\n");

export function buildRichMessagePayload(chatId: string | number, html = richMessageProbeHtml): NativeLayoutPayload {
  return {
    method: "sendRichMessage",
    body: {
      chat_id: String(chatId),
      rich_message: {
        html,
      },
    },
  };
}

export function buildRichMessageDraftPayload(
  chatId: string | number,
  draftId: number,
  html = "<tg-thinking>Thinking</tg-thinking>",
): NativeLayoutPayload {
  return {
    method: "sendRichMessageDraft",
    body: {
      chat_id: String(chatId),
      draft_id: draftId,
      rich_message: {
        html,
      },
    },
  };
}

export const spikeInputs = {
  logDump: Array.from({ length: 140 }, (_, i) => `[${i.toString().padStart(3, "0")}] worker lane event: ${"x".repeat(26)}`).join("\n"),
  table4Col: [
    "| Service | Status | Latency | Owner |",
    "|---|---|---:|---|",
    "| web-api | healthy | 12ms | platform |",
    "| queue | amber | 240ms | ops |",
    "| discord | healthy | 40ms | bridge |",
  ].join("\n"),
  nestedList: [
    "- Root",
    "  - Child",
    "    - Grandchild",
    "      - Deep item with <unsafe> chars & quotes",
  ].join("\n"),
};

async function main(): Promise<void> {
  const chatId = process.env.TELEGRAM_LAYOUT_SPIKE_CHAT_ID ?? "0";
  for (const [name, input] of Object.entries(spikeInputs)) {
    const route = routeNativeLayout(input);
    const payload = buildNativeLayoutPayload(input, chatId);
    console.log(JSON.stringify({
      name,
      route,
      method: payload.method,
      bodyType: payload.body instanceof FormData ? "FormData" : "json",
    }, null, 2));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && splitTableRow(trimmed).length >= 2;
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}
