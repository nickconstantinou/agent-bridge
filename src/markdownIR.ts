export type IRNode =
  | { type: "text"; value: string }
  | { type: "bold"; value: string }
  | { type: "code_inline"; value: string }
  | { type: "code_block"; value: string; language?: string }
  | { type: "heading"; level: number; value: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "list"; items: string[]; ordered?: boolean };

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
      const suffix = hasTrailingBlank ? "\n\n" : beforeBlock ? "\n" : "";
      parseInlineSpans(paragraph.join("\n") + suffix, nodes);
    }
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i];

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
      i += 1; // skip closing fence
      nodes.push({ type: "code_block", value: contentLines.join("\n"), language });
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph(true);
      nodes.push({ type: "heading", level: headingMatch[1].length, value: headingMatch[2].trim() });
      i += 1;
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && TABLE_SEPARATOR_RE.test(lines[i + 1])) {
      flushParagraph(true);
      const headers = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      nodes.push({ type: "table", headers, rows });
      continue;
    }

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

    paragraph.push(line);
    i += 1;
  }

  flushParagraph();
  return nodes;
}

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
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) {
        flushBuffer();
        nodes.push({ type: "bold", value: text.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }

    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flushBuffer();
        nodes.push({ type: "code_inline", value: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    buffer += text[i];
    i += 1;
  }

  flushBuffer();
}

export type MarkerTable = {
  text: (text: string) => string;
  bold: (text: string) => string;
  code_inline: (text: string) => string;
  code_block: (text: string, language?: string) => string;
  heading: (text: string, level: number) => string;
  table: (headers: string[], rows: string[][]) => string;
  list: (items: string[], ordered?: boolean) => string;
};

export function renderMarkerString(ir: IRNode[], markers: MarkerTable): string {
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
      case "code_inline":
        parts.push(markers.code_inline(node.value));
        break;
      case "code_block":
        parts.push(markers.code_block(node.value, node.language));
        if (!isLast) parts.push("\n");
        break;
      case "heading":
        parts.push(markers.heading(node.value, node.level));
        if (!isLast) parts.push("\n");
        break;
      case "table":
        parts.push(markers.table(node.headers, node.rows));
        if (!isLast) parts.push("\n");
        break;
      case "list":
        parts.push(markers.list(node.items, node.ordered));
        if (!isLast) parts.push("\n");
        break;
    }
  }
  return parts.join("");
}

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

export const DISCORD_MARKERS: MarkerTable = {
  text: (text) => text,
  bold: (text) => `**${text}**`,
  code_inline: (text) => `\`${text}\``,
  code_block: (text, language) => "```" + (language ?? "") + "\n" + text + "\n```",
  heading: (text, level) => `${"#".repeat(level)} ${text}`,
  list: (items, ordered) =>
    ordered
      ? items.map((item, i) => `${i + 1}. ${item}`).join("\n")
      : items.map((item) => `- ${item}`).join("\n"),
  table: (headers, rows) =>
    renderTableAsCards(headers, rows, (label) => `**${label}:**`, "- ", (text) => text),
};

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderInlineMarkerText(text: string, markers: Pick<MarkerTable, "text" | "bold" | "code_inline">): string {
  const parts: string[] = [];
  for (const node of parseMarkdownToIR(text)) {
    if (node.type === "bold") {
      parts.push(markers.bold(node.value));
    } else if (node.type === "code_inline") {
      parts.push(markers.code_inline(node.value));
    } else if (node.type === "text") {
      parts.push(markers.text(node.value));
    } else if (node.type === "code_block") {
      parts.push(markers.code_inline(node.value));
    } else if (node.type === "heading") {
      parts.push(markers.bold(node.value));
    } else if (node.type === "list") {
      parts.push(node.items.map((item) => renderInlineMarkerText(item, markers)).join("\n"));
    } else if (node.type === "table") {
      parts.push(node.rows.flat().map((cell) => renderInlineMarkerText(cell, markers)).join(" "));
    }
  }
  return parts.join("");
}

const renderTelegramInlineHtml = (text: string) => renderInlineMarkerText(text, {
  text: escapeHtml,
  bold: (value) => `<b>${escapeHtml(value)}</b>`,
  code_inline: (value) => `<code>${escapeHtml(value)}</code>`,
});

export const TELEGRAM_HTML_MARKERS: MarkerTable = {
  text: (text) => escapeHtml(text),
  bold: (text) => `<b>${escapeHtml(text)}</b>`,
  code_inline: (text) => `<code>${escapeHtml(text)}</code>`,
  code_block: (text, language) => language ? `<pre language="${escapeHtml(language)}">${escapeHtml(text)}</pre>` : `<pre>${escapeHtml(text)}</pre>`,
  heading: (text) => `<b>${escapeHtml(text)}</b>`,
  list: (items, ordered) =>
    ordered
      ? items.map((item, i) => `${i + 1}. ${renderTelegramInlineHtml(item)}`).join("\n")
      : items.map((item) => `• ${renderTelegramInlineHtml(item)}`).join("\n"),
  // Telegram HTML parse_mode does not support <table> — render as card lines instead
  table: (headers, rows) =>
    renderTableAsCards(headers, rows, (label) => `<b>${escapeHtml(label)}</b>`, "• ", renderTelegramInlineHtml),
};

/** Render markdown with <table> HTML for sendRichMessage (Telegram Bot API 10.1+). */
export function markdownTableToRichHtml(markdown: string): string {
  return renderMarkerString(parseMarkdownToIR(markdown), TELEGRAM_RICH_HTML_MARKERS);
}

export const TELEGRAM_RICH_HTML_MARKERS: MarkerTable = {
  text: (text) => escapeHtml(text),
  bold: (text) => `<b>${escapeHtml(text)}</b>`,
  code_inline: (text) => `<code>${escapeHtml(text)}</code>`,
  code_block: (text, language) => language ? `<pre language="${escapeHtml(language)}">${escapeHtml(text)}</pre>` : `<pre>${escapeHtml(text)}</pre>`,
  heading: (text) => `<b>${escapeHtml(text)}</b>`,
  list: (items, ordered) =>
    ordered
      ? items.map((item, i) => `${i + 1}. ${renderTelegramInlineHtml(item)}`).join("\n")
      : items.map((item) => `• ${renderTelegramInlineHtml(item)}`).join("\n"),
  table: (headers, rows) =>
    `<table bordered striped><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, i) => `<td>${escapeHtml(row[i] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
};

export function discordMarkdownIrEnabled(): boolean {
  return process.env.DISCORD_MARKDOWN_IR_ENABLED === "true";
}
