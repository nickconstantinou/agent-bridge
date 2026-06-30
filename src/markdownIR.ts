/**
 * markdownIR.ts — Intermediate Representation (IR) pipeline for markdown rendering.
 *
 * ## Architecture overview
 *
 * Markdown from CLI output goes through a two-stage pipeline before reaching Telegram:
 *
 *   1. PARSE  — parseMarkdownToIR() converts raw markdown text into a typed IRNode[]
 *               tree. Block nodes (headings, tables, lists, code blocks) are detected
 *               line-by-line; inline spans (bold, code, links) are parsed inside
 *               paragraph text via parseInlineSpans().
 *
 *   2. RENDER — renderMarkerString() walks the IRNode[] and applies a MarkerTable,
 *               which is a set of functions that map each node type to its target
 *               format string. Swapping the MarkerTable changes the output format
 *               (Telegram HTML, Discord Markdown, etc.) without touching the parser.
 *
 * ## Two Telegram rendering paths
 *
 * Telegram has two distinct HTML modes that handle whitespace differently:
 *
 *   Path A — parse_mode: "HTML"  (sendEntityMessages)
 *     Used for all non-table messages. Telegram's own HTML parser preserves literal
 *     \n characters as line breaks. MarkerTable: TELEGRAM_HTML_MARKERS.
 *     Block separator: "\n\n".
 *
 *   Path B — rich_message: { html: "..." }  (sendRichMessage, Bot API 10.1+)
 *     Used when the message contains a markdown table. The payload is rendered as a
 *     real HTML document, so \n is treated as whitespace and COLLAPSED by the HTML
 *     parser — exactly like a browser. All line breaks MUST be <br> tags, and the
 *     block separator must also be "<br><br>".
 *     MarkerTable: TELEGRAM_RICH_HTML_MARKERS. Block separator: "<br><br>".
 *     Falls back to Path A (card-style) if sendRichMessage is unavailable.
 *
 * ## Routing (messageDelivery.ts → routeNativeLayout)
 *
 *   table detected → kind:"html" → try sendRichMessage (Path B) → fallback sendEntityMessages (Path A)
 *   no table       → kind:"text" → sendEntityMessages (Path A)
 *   very long text → kind:"document" → sendDocumentBuffer (file attachment)
 *
 * ## Inline rendering inside list items
 *
 * List item content is itself markdown and needs inline span parsing. renderInlineMarkerText()
 * recursively parses item strings and renders them using a reduced marker set (text, bold,
 * code_inline, link). It accepts a lineSep parameter so that Path B can use "<br>" while
 * Path A uses "\n". renderTelegramInlineHtml() is the concrete closure for Path B.
 *
 * ## Known limitations (Telegram HTML does not support these tags)
 *   - Headings rendered as <b> only (no <h1>/<h2>)
 *   - Italic (*text*) not parsed — shows as raw *text*
 *   - Strikethrough (~~text~~) not parsed — shows as raw ~~text~~
 *   - Horizontal rule (---) falls through to paragraph text
 */

// ── IR node types ─────────────────────────────────────────────────────────────

/** All possible nodes produced by parseMarkdownToIR. */
export type IRNode =
  | { type: "text"; value: string }
  | { type: "bold"; value: string }
  | { type: "code_inline"; value: string }
  | { type: "code_block"; value: string; language?: string }
  | { type: "heading"; level: number; value: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "list"; items: string[]; ordered?: boolean }
  | { type: "link"; text: string; url: string };

// ── Table helpers ─────────────────────────────────────────────────────────────

// Matches a GFM table separator row: |---|---|  or :---:|:---:| etc.
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

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

// ── Block parser ──────────────────────────────────────────────────────────────

/**
 * Convert a markdown string into a flat IRNode array.
 *
 * Parsing is line-by-line. Recognised block patterns (in priority order):
 *   ``` fences → code_block
 *   # heading  → heading
 *   | table |  → table (requires separator row on line i+1)
 *   - / * item → list (unordered)
 *   1. item    → list (ordered)
 *   everything else accumulates into a paragraph, flushed as text node(s)
 *
 * Sub-bullets with leading spaces (e.g. "   - item") are NOT recognised as
 * nested list nodes — they fall into the paragraph accumulator and end up
 * as text content inside the surrounding list item when the item text is
 * re-parsed by renderInlineMarkerText.
 *
 * Paragraph flushing preserves inter-paragraph whitespace:
 *   trailing blank line → suffix "\n\n" (paragraph break)
 *   followed by a block → suffix "\n"   (tighter spacing)
 *   end of input        → no suffix
 */
export function parseMarkdownToIR(markdown: string): IRNode[] {
  const lines = markdown.split(/\r?\n/);
  const nodes: IRNode[] = [];
  let paragraph: string[] = [];
  let i = 0;

  const flushParagraph = (beforeBlock?: boolean) => {
    if (paragraph.length === 0) return;
    const hasTrailingBlank = paragraph[paragraph.length - 1] === "";
    while (paragraph.length > 0 && paragraph[paragraph.length - 1] === "") paragraph.pop();
    if (paragraph.length > 0) {
      // Preserve spacing: double-blank = paragraph break, before-block = single break.
      const suffix = hasTrailingBlank ? "\n\n" : beforeBlock ? "\n" : "";
      parseInlineSpans(paragraph.join("\n") + suffix, nodes);
    }
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // ── Fenced code block ────────────────────────────────────────────────────
    if (line.trim().startsWith("```")) {
      flushParagraph(true);
      const languageMatch = line.trim().match(/^```([A-Za-z0-9_+.-]*)\s*$/);
      const language = languageMatch && languageMatch[1] ? languageMatch[1] : undefined;
      const contentLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        contentLines.push(lines[i]);
        i += 1;
      }
      i += 1; // skip closing ```
      nodes.push({ type: "code_block", value: contentLines.join("\n"), language });
      continue;
    }

    // ── Heading (# / ## / ###) ───────────────────────────────────────────────
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph(true);
      nodes.push({ type: "heading", level: headingMatch[1].length, value: headingMatch[2].trim() });
      i += 1;
      continue;
    }

    // ── GFM table (header row + separator row) ───────────────────────────────
    if (isTableRow(line) && i + 1 < lines.length && TABLE_SEPARATOR_RE.test(lines[i + 1])) {
      flushParagraph(true);
      const headers = splitTableRow(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      nodes.push({ type: "table", headers, rows });
      continue;
    }

    // ── Unordered list (- or * at column 0) ─────────────────────────────────
    if (/^[-*]\s+\S/.test(line)) {
      flushParagraph(true);
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+\S/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, "").trim());
        i += 1;
      }
      nodes.push({ type: "list", items });
      continue;
    }

    // ── Ordered list (1. at column 0) ───────────────────────────────────────
    if (/^\d+\.\s+\S/.test(line)) {
      flushParagraph(true);
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+\S/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, "").trim());
        i += 1;
      }
      nodes.push({ type: "list", ordered: true, items });
      continue;
    }

    // ── Plain paragraph line ─────────────────────────────────────────────────
    paragraph.push(line);
    i += 1;
  }

  flushParagraph();
  return nodes;
}

// ── Inline span parser ────────────────────────────────────────────────────────

/**
 * Parse inline markdown spans within a paragraph string and append IRNodes.
 *
 * Recognised patterns (in order of detection):
 *   **text**      → bold node
 *   `text`        → code_inline node
 *   [text](url)   → link node
 *   everything else → text node (accumulated in buffer, flushed on span boundary)
 *
 * \n characters in the buffer are preserved as-is so that paragraph spacing
 * survives into the text node value (renderMarkerString respects them or
 * converts them to <br> depending on the active MarkerTable).
 */
function parseInlineSpans(text: string, nodes: IRNode[]): void {
  let i = 0;
  let buffer = "";

  const flushBuffer = () => {
    if (buffer) {
      nodes.push({ type: "text", value: buffer });
      buffer = "";
    }
  };

  while (i < text.length) {
    // Bold: **text**
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) {
        flushBuffer();
        nodes.push({ type: "bold", value: text.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }

    // Inline code: `text`
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flushBuffer();
        nodes.push({ type: "code_inline", value: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // Link: [text](url)
    if (text[i] === "[") {
      const closeBracket = text.indexOf("]", i + 1);
      if (closeBracket > i && text[closeBracket + 1] === "(") {
        const closeParen = text.indexOf(")", closeBracket + 2);
        if (closeParen > closeBracket + 2) {
          flushBuffer();
          nodes.push({
            type: "link",
            text: text.slice(i + 1, closeBracket),
            url: text.slice(closeBracket + 2, closeParen),
          });
          i = closeParen + 1;
          continue;
        }
      }
    }

    buffer += text[i];
    i += 1;
  }

  flushBuffer();
}

// ── MarkerTable interface ─────────────────────────────────────────────────────

/**
 * A set of transform functions that convert each IR node type to a target string.
 * Swap the MarkerTable to change the output format without touching the parser.
 *
 * Implementations: TELEGRAM_HTML_MARKERS, TELEGRAM_RICH_HTML_MARKERS, DISCORD_MARKERS.
 */
export type MarkerTable = {
  text: (text: string) => string;
  bold: (text: string) => string;
  code_inline: (text: string) => string;
  code_block: (text: string, language?: string) => string;
  heading: (text: string, level: number) => string;
  table: (headers: string[], rows: string[][]) => string;
  list: (items: string[], ordered?: boolean) => string;
  link: (text: string, url: string) => string;
};

// ── Renderer ──────────────────────────────────────────────────────────────────

/**
 * Walk an IRNode[] and produce a single output string using the given MarkerTable.
 *
 * blockSeparator is inserted AFTER block-level nodes (code_block, heading, table,
 * list) when they are not the last node in the array. Inline nodes (text, bold,
 * code_inline, link) do not receive a trailing separator — their spacing comes
 * from the \n characters embedded in text node values by the paragraph flusher.
 *
 * The correct blockSeparator depends on the rendering path:
 *   parse_mode: HTML  → "\n\n"  (Telegram preserves \n as a line break)
 *   rich_message HTML → "<br><br>"  (\n is whitespace in a real HTML document)
 */
export function renderMarkerString(ir: IRNode[], markers: MarkerTable, blockSeparator = "\n"): string {
  const parts: string[] = [];
  for (let idx = 0; idx < ir.length; idx++) {
    const node = ir[idx];
    const isLast = idx === ir.length - 1;
    switch (node.type) {
      case "text":
        parts.push(markers.text(node.value));
        break;
      case "bold":
        parts.push(markers.bold(node.value));
        break;
      case "link":
        parts.push(markers.link(node.text, node.url));
        break;
      case "code_inline":
        parts.push(markers.code_inline(node.value));
        break;
      case "code_block":
        parts.push(markers.code_block(node.value, node.language));
        if (!isLast) parts.push(blockSeparator);
        break;
      case "heading":
        parts.push(markers.heading(node.value, node.level));
        if (!isLast) parts.push(blockSeparator);
        break;
      case "table":
        parts.push(markers.table(node.headers, node.rows));
        if (!isLast) parts.push(blockSeparator);
        break;
      case "list":
        parts.push(markers.list(node.items, node.ordered));
        if (!isLast) parts.push(blockSeparator);
        break;
    }
  }
  return parts.join("");
}

// ── Table card fallback ───────────────────────────────────────────────────────

/**
 * Render a table as stacked label/value card lines when native <table> is unavailable.
 * Each row becomes: "Label value\n• Field2 value\n• Field3 value"
 * Used by TELEGRAM_HTML_MARKERS (parse_mode:HTML does not support <table>).
 */
function renderTableAsCards(
  headers: string[],
  rows: string[][],
  formatLabel: (label: string) => string,
  bulletPrefix: string,
  renderValue: (text: string) => string,
): string {
  const lines: string[] = [];
  for (const row of rows) {
    const [firstHeader, ...restHeaders] = headers;
    const [firstCell, ...restCells] = row;
    lines.push(`${formatLabel(firstHeader ?? "Item")} ${renderValue(firstCell ?? "")}`);
    for (let c = 0; c < restHeaders.length; c += 1) {
      lines.push(`${bulletPrefix}${formatLabel(restHeaders[c] ?? `Field ${c + 2}`)} ${renderValue(restCells[c] ?? "")}`);
    }
  }
  return lines.join("\n");
}

// ── Discord markers ───────────────────────────────────────────────────────────

/** Passthrough markers that re-emit markdown — used for Discord message delivery. */
export const DISCORD_MARKERS: MarkerTable = {
  text: (text) => text,
  bold: (text) => `**${text}**`,
  code_inline: (text) => `\`${text}\``,
  code_block: (text, language) => "```" + (language ?? "") + "\n" + text + "\n```",
  heading: (text, level) => `${"#".repeat(level)} ${text}`,
  link: (linkText, url) => `[${linkText}](${url})`,
  list: (items, ordered) =>
    ordered
      ? items.map((item, i) => `${i + 1}. ${item}`).join("\n")
      : items.map((item) => `- ${item}`).join("\n"),
  table: (headers, rows) =>
    renderTableAsCards(headers, rows, (label) => `**${label}:**`, "- ", (text) => text),
};

// ── HTML helpers ──────────────────────────────────────────────────────────────

/** Escape characters that are special in HTML attribute and text contexts. */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Recursively render inline markdown within a single list item (or table cell).
 *
 * This is a reduced-scope version of renderMarkerString: it re-parses the item
 * string through parseMarkdownToIR and applies only the inline markers. Block
 * nodes that appear inside item text (e.g. sub-bullets indented with spaces)
 * are handled gracefully: headings → bold, code_blocks → code_inline, nested
 * lists → recursively rendered and joined with lineSep.
 *
 * lineSep controls how multi-line content within an item is joined:
 *   "\n"   for parse_mode:HTML (TELEGRAM_HTML_MARKERS path)
 *   "<br>" for rich_message HTML (renderTelegramInlineHtml, TELEGRAM_RICH_HTML_MARKERS path)
 */
function renderInlineMarkerText(
  text: string,
  markers: Pick<MarkerTable, "text" | "bold" | "code_inline" | "link">,
  lineSep = "\n",
): string {
  const parts: string[] = [];
  for (const node of parseMarkdownToIR(text)) {
    if (node.type === "bold") {
      parts.push(markers.bold(node.value));
    } else if (node.type === "code_inline") {
      parts.push(markers.code_inline(node.value));
    } else if (node.type === "link") {
      parts.push(markers.link(node.text, node.url));
    } else if (node.type === "text") {
      parts.push(markers.text(node.value));
    } else if (node.type === "code_block") {
      // Degrade to inline code inside a list item — block fences don't render well inline.
      parts.push(markers.code_inline(node.value));
    } else if (node.type === "heading") {
      parts.push(markers.bold(node.value));
    } else if (node.type === "list") {
      parts.push(node.items.map((item) => renderInlineMarkerText(item, markers, lineSep)).join(lineSep));
    } else if (node.type === "table") {
      // Flatten table cells to space-separated text inside a list item.
      parts.push(node.rows.flat().map((cell) => renderInlineMarkerText(cell, markers, lineSep)).join(" "));
    }
  }
  return parts.join("");
}

// ── Telegram rich HTML inline renderer ───────────────────────────────────────

/**
 * Inline renderer for TELEGRAM_RICH_HTML_MARKERS list items.
 *
 * The rich_message HTML path sends a real HTML document — \n collapses to
 * whitespace. All line breaks within inline content must be <br>, hence the
 * explicit text conversion and lineSep="<br>".
 */
const renderTelegramInlineHtml = (text: string) => renderInlineMarkerText(text, {
  text: (value) => escapeHtml(value).replace(/\n\n/g, "<br><br>").replace(/\n/g, "<br>"),
  bold: (value) => `<b>${escapeHtml(value)}</b>`,
  code_inline: (value) => `<code>${escapeHtml(value)}</code>`,
  link: (linkText, url) => `<a href="${escapeHtml(url)}">${escapeHtml(linkText)}</a>`,
}, "<br>");

// ── Telegram parse_mode:HTML markers (Path A) ─────────────────────────────────

/**
 * MarkerTable for Telegram's parse_mode:"HTML" delivery path (sendEntityMessages).
 *
 * In this mode Telegram's own HTML parser handles the content. It preserves
 * literal \n as line breaks, so no <br> conversion is needed. Tables are NOT
 * supported — they fall back to renderTableAsCards (stacked label/value lines).
 *
 * Supported Telegram HTML tags: <b>, <i>, <code>, <pre>, <a href>, <s>, <u>.
 * Unsupported: <h1>, <table>, <ul>, <li>, etc.
 */
export const TELEGRAM_HTML_MARKERS: MarkerTable = {
  text: (text) => escapeHtml(text),
  bold: (text) => `<b>${escapeHtml(text)}</b>`,
  code_inline: (text) => `<code>${escapeHtml(text)}</code>`,
  code_block: (text, language) => language
    ? `<pre language="${escapeHtml(language)}">${escapeHtml(text)}</pre>`
    : `<pre>${escapeHtml(text)}</pre>`,
  // Telegram has no heading tags — render as bold.
  heading: (text) => `<b>${escapeHtml(text)}</b>`,
  link: (linkText, url) => `<a href="${escapeHtml(url)}">${escapeHtml(linkText)}</a>`,
  // List items joined with \n — Telegram's HTML parser renders \n as a line break.
  list: (items, ordered) =>
    ordered
      ? items.map((item, i) => `${i + 1}. ${renderTelegramInlineHtml(item)}`).join("\n")
      : items.map((item) => `• ${renderTelegramInlineHtml(item)}`).join("\n"),
  // Tables unsupported in parse_mode:HTML — degrade to card-style stacked lines.
  table: (headers, rows) =>
    renderTableAsCards(headers, rows, (label) => `<b>${escapeHtml(label)}</b>`, "• ", renderTelegramInlineHtml),
};

// ── Telegram rich_message HTML markers (Path B) ───────────────────────────────

/**
 * Convert a markdown string containing a GFM table to a rich HTML string
 * suitable for sendRichMessage (Telegram Bot API 10.1+).
 *
 * The block separator is "<br><br>" because the HTML document's whitespace
 * normalisation collapses plain \n to a space.
 */
export function markdownTableToRichHtml(markdown: string): string {
  return renderMarkerString(parseMarkdownToIR(markdown), TELEGRAM_RICH_HTML_MARKERS, "<br><br>");
}

/**
 * MarkerTable for Telegram's rich_message HTML delivery path (sendRichMessage).
 *
 * sendRichMessage wraps the HTML in a full document context where whitespace
 * normalisation applies — \n is treated as a space, not a line break. Every
 * break must be an explicit <br> tag. This affects text nodes, list item
 * joiners, and the block separator passed to renderMarkerString.
 *
 * Tables ARE supported here via native <table bordered striped> markup
 * (Telegram Bot API 10.1 feature). If sendRichMessage fails or is unavailable,
 * messageDelivery.ts falls back to sendEntityMessages (Path A / TELEGRAM_HTML_MARKERS).
 */
export const TELEGRAM_RICH_HTML_MARKERS: MarkerTable = {
  // \n → <br>: required because this HTML is parsed as a document, not by Telegram's custom parser.
  text: (text) => escapeHtml(text).replace(/\n\n/g, "<br><br>").replace(/\n/g, "<br>"),
  bold: (text) => `<b>${escapeHtml(text)}</b>`,
  code_inline: (text) => `<code>${escapeHtml(text)}</code>`,
  // <pre> preserves internal whitespace so no \n→<br> conversion needed inside code blocks.
  code_block: (text, language) => language
    ? `<pre language="${escapeHtml(language)}">${escapeHtml(text)}</pre>`
    : `<pre>${escapeHtml(text)}</pre>`,
  heading: (text) => `<b>${escapeHtml(text)}</b>`,
  link: (linkText, url) => `<a href="${escapeHtml(url)}">${escapeHtml(linkText)}</a>`,
  // List items joined with <br> — \n would be collapsed in the document context.
  list: (items, ordered) =>
    ordered
      ? items.map((item, i) => `${i + 1}. ${renderTelegramInlineHtml(item)}`).join("<br>")
      : items.map((item) => `• ${renderTelegramInlineHtml(item)}`).join("<br>"),
  // Native table with bordered + striped attributes for Telegram Bot API 10.1.
  table: (headers, rows) =>
    `<table bordered striped>` +
    `<thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>` +
    `<tbody>${rows.map((row) => `<tr>${headers.map((_, i) => `<td>${escapeHtml(row[i] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody>` +
    `</table>`,
};

// ── Misc exports ──────────────────────────────────────────────────────────────

export function discordMarkdownIrEnabled(): boolean {
  return process.env.DISCORD_MARKDOWN_IR_ENABLED === "true";
}
