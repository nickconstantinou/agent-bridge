export type IRNode =
  | { type: "text"; value: string }
  | { type: "bold"; value: string }
  | { type: "code_inline"; value: string }
  | { type: "code_block"; value: string; language?: string }
  | { type: "heading"; level: number; value: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "list"; items: string[] };

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

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    parseInlineSpans(paragraph.join("\n"), nodes);
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith("```")) {
      flushParagraph();
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
      flushParagraph();
      nodes.push({ type: "heading", level: headingMatch[1].length, value: headingMatch[2].trim() });
      i += 1;
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && TABLE_SEPARATOR_RE.test(lines[i + 1])) {
      flushParagraph();
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
