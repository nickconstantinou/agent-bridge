export const DEFAULT_DOCUMENT_LENGTH_THRESHOLD = 3_500;
export const DEFAULT_DOCUMENT_CODE_BLOCK_THRESHOLD = 3;

export type NativeLayoutRoute =
  | { kind: "document"; reason: "length" | "code_blocks"; codeBlocks: number; length: number }
  | { kind: "rich"; reason: "table"; codeBlocks: number; length: number }
  | { kind: "html"; reason: "table"; codeBlocks: number; length: number }
  | { kind: "plain"; reason: "default"; codeBlocks: number; length: number };

const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

export function documentLengthThreshold(): number {
  return envInt("TELEGRAM_LAYOUT_DOCUMENT_THRESHOLD", DEFAULT_DOCUMENT_LENGTH_THRESHOLD);
}

export function documentCodeBlockThreshold(): number {
  return envInt("TELEGRAM_LAYOUT_CODE_BLOCK_THRESHOLD", DEFAULT_DOCUMENT_CODE_BLOCK_THRESHOLD);
}

export function richMessagesEnabled(): boolean {
  return process.env.TELEGRAM_RICH_MESSAGES_ENABLED === "true";
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function countCodeBlocks(markdown: string): number {
  return Math.floor((markdown.match(/```/g) ?? []).length / 2);
}

export function hasMarkdownTable(markdown: string): boolean {
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (isTableRow(lines[i]) && TABLE_SEPARATOR_RE.test(lines[i + 1])) return true;
  }
  return false;
}

export function routeNativeLayout(
  markdown: string,
  options: { richEnabled?: boolean; documentLength?: number; documentCodeBlocks?: number } = {},
): NativeLayoutRoute {
  const codeBlocks = countCodeBlocks(markdown);
  const length = markdown.length;
  const documentLength = options.documentLength ?? documentLengthThreshold();
  const documentCodeBlocks = options.documentCodeBlocks ?? documentCodeBlockThreshold();

  if (length > documentLength) return { kind: "document", reason: "length", codeBlocks, length };
  if (codeBlocks > documentCodeBlocks) return { kind: "document", reason: "code_blocks", codeBlocks, length };
  if (hasMarkdownTable(markdown)) {
    return {
      kind: options.richEnabled ? "rich" : "html",
      reason: "table",
      codeBlocks,
      length,
    };
  }
  return { kind: "plain", reason: "default", codeBlocks, length };
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
    i += 2;
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

export function markdownTableToRichHtml(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const output: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!isTableRow(lines[i]) || !TABLE_SEPARATOR_RE.test(lines[i + 1] ?? "")) {
      const line = lines[i].trim();
      if (line) output.push(`<p>${escapeHtml(line)}</p>`);
      continue;
    }

    const headers = splitTableRow(lines[i]);
    i += 2;
    const rows: string[][] = [];
    while (i < lines.length && isTableRow(lines[i])) {
      rows.push(splitTableRow(lines[i]));
      i += 1;
    }
    i -= 1;

    output.push("<table bordered striped>");
    output.push(`<tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr>`);
    for (const row of rows) {
      output.push(`<tr>${headers.map((_, index) => `<td>${escapeHtml(row[index] ?? "")}</td>`).join("")}</tr>`);
    }
    output.push("</table>");
  }

  return output.join("\n");
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
