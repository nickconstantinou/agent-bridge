export const DEFAULT_DOCUMENT_LENGTH_THRESHOLD = 3_500;
export const DEFAULT_DOCUMENT_CODE_BLOCK_THRESHOLD = 3;

export type NativeLayoutRoute =
  | { kind: "document"; reason: "length" | "code_blocks"; codeBlocks: number; length: number }
  | { kind: "html"; reason: "table"; codeBlocks: number; length: number }
  | { kind: "plain"; reason: "default"; codeBlocks: number; length: number };

const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

export function documentLengthThreshold(): number {
  return envInt("TELEGRAM_LAYOUT_DOCUMENT_THRESHOLD", DEFAULT_DOCUMENT_LENGTH_THRESHOLD);
}

export function documentCodeBlockThreshold(): number {
  return envInt("TELEGRAM_LAYOUT_CODE_BLOCK_THRESHOLD", DEFAULT_DOCUMENT_CODE_BLOCK_THRESHOLD);
}

export function documentFallbackEnabled(): boolean {
  return process.env.TELEGRAM_DOCUMENT_FALLBACK_ENABLED === "true";
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
  options: { documentEnabled?: boolean; documentLength?: number; documentCodeBlocks?: number } = {},
): NativeLayoutRoute {
  const codeBlocks = countCodeBlocks(markdown);
  const length = markdown.length;
  const documentLength = options.documentLength ?? documentLengthThreshold();
  const documentCodeBlocks = options.documentCodeBlocks ?? documentCodeBlockThreshold();

  if (options.documentEnabled) {
    if (length > documentLength) return { kind: "document", reason: "length", codeBlocks, length };
    if (codeBlocks > documentCodeBlocks) return { kind: "document", reason: "code_blocks", codeBlocks, length };
  }
  if (hasMarkdownTable(markdown)) {
    return { kind: "html", reason: "table", codeBlocks, length };
  }
  return { kind: "plain", reason: "default", codeBlocks, length };
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
