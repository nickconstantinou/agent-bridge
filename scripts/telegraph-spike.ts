#!/usr/bin/env tsx
/**
 * Telegraph Instant View spike.
 *
 * Converts Markdown agent output → Telegraph page → telegra.ph URL.
 * The URL opens natively in Telegram Instant View with no rhash needed
 * because Telegram auto-detects telegra.ph domains.
 *
 * Run: npx tsx scripts/telegraph-spike.ts
 */

export type TelegraphNode = string | {
  tag: string;
  attrs?: Record<string, string>;
  children?: TelegraphNode[];
};

// ---------------------------------------------------------------------------
// ANSI stripping
// ---------------------------------------------------------------------------

export function stripAnsi(text: string): string {
  // Covers color, bold, cursor movement, erase, and private sequences
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\[[?][0-9;]*[A-Za-z]/g, "");
}

// ---------------------------------------------------------------------------
// Inline formatting parser
// Returns an array of TelegraphNode (strings and tagged elements)
// ---------------------------------------------------------------------------

function parseInline(text: string): TelegraphNode[] {
  const nodes: TelegraphNode[] = [];
  // Process in order: code, bold, italic — using regex with alternation
  const pattern = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(__([^_]+)__)|(\*([^*]+)\*)|(_([^_]+)_)/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
    if (match[1]) {
      nodes.push({ tag: "code", children: [match[2] as string] });
    } else if (match[3]) {
      nodes.push({ tag: "strong", children: [match[4] as string] });
    } else if (match[5]) {
      nodes.push({ tag: "strong", children: [match[6] as string] });
    } else if (match[7]) {
      nodes.push({ tag: "em", children: [match[8] as string] });
    } else if (match[9]) {
      nodes.push({ tag: "em", children: [match[10] as string] });
    }
    last = match.index + match[0].length;
  }

  if (last < text.length) {
    nodes.push(text.slice(last));
  }

  return nodes.length > 0 ? nodes : [text];
}

// ---------------------------------------------------------------------------
// Block-level Markdown → Telegraph nodes
// ---------------------------------------------------------------------------

export function markdownToTelegraphNodes(markdown: string): TelegraphNode[] {
  const clean = stripAnsi(markdown);
  const lines = clean.split(/\r?\n/);
  const result: TelegraphNode[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;

    // Fenced code block
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i] as string)) {
        codeLines.push(lines[i] as string);
        i++;
      }
      i++; // skip closing ```
      result.push({
        tag: "pre",
        children: [{ tag: "code", attrs: lang ? { class: `language-${lang}` } : undefined, children: [codeLines.join("\n")] }],
      });
      continue;
    }

    // Table (lines containing | separators)
    if (/^\|/.test(line)) {
      const tableLines: string[] = [];
      while (i < lines.length && /^\|/.test(lines[i] as string)) {
        tableLines.push(lines[i] as string);
        i++;
      }
      // Render as pre since Telegraph has no table tag
      result.push({ tag: "pre", children: [tableLines.join("\n")] });
      continue;
    }

    // Horizontal rule
    if (/^[-*]{3,}$/.test(line.trim())) {
      result.push({ tag: "hr" });
      i++;
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = (headingMatch[1] as string).length;
      const tag = level <= 3 ? "h3" : "h4";
      result.push({ tag, children: parseInline(headingMatch[2] as string) });
      i++;
      continue;
    }

    // Unordered list
    if (/^[-*+]\s/.test(line)) {
      const items: TelegraphNode[] = [];
      while (i < lines.length && /^[-*+]\s/.test(lines[i] as string)) {
        const text = (lines[i] as string).replace(/^[-*+]\s+/, "");
        items.push({ tag: "li", children: parseInline(text) });
        i++;
      }
      result.push({ tag: "ul", children: items });
      continue;
    }

    // Ordered list
    if (/^\d+\.\s/.test(line)) {
      const items: TelegraphNode[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i] as string)) {
        const text = (lines[i] as string).replace(/^\d+\.\s+/, "");
        items.push({ tag: "li", children: parseInline(text) });
        i++;
      }
      result.push({ tag: "ol", children: items });
      continue;
    }

    // Blank line — skip
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph — accumulate consecutive non-special lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      (lines[i] as string).trim() !== "" &&
      !/^```/.test(lines[i] as string) &&
      !/^\|/.test(lines[i] as string) &&
      !/^[-*]{3,}$/.test((lines[i] as string).trim()) &&
      !/^#{1,6}\s/.test(lines[i] as string) &&
      !/^[-*+]\s/.test(lines[i] as string) &&
      !/^\d+\.\s/.test(lines[i] as string)
    ) {
      paraLines.push(lines[i] as string);
      i++;
    }

    if (paraLines.length > 0) {
      result.push({ tag: "p", children: parseInline(paraLines.join(" ")) });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Trigger logic
// ---------------------------------------------------------------------------

export function shouldUseInstantView(text: string): boolean {
  if (text.length > 1500) return true;
  if (/^\|.+\|/m.test(text) && /^\|[-:| ]+\|/m.test(text)) return true;
  const codeBlockCount = (text.match(/^```/gm) ?? []).length;
  if (codeBlockCount >= 4) return true; // 2 open + 2 close = 2 blocks
  return false;
}

// ---------------------------------------------------------------------------
// Telegraph API client
// ---------------------------------------------------------------------------

interface TelegraphApiOk<T> {
  ok: true;
  result: T;
}
interface TelegraphApiError {
  ok: false;
  error: string;
}
type TelegraphApiResponse<T> = TelegraphApiOk<T> | TelegraphApiError;

async function telegraphPost<T>(
  endpoint: string,
  body: Record<string, unknown>,
  fetchFn: typeof fetch,
): Promise<T> {
  const res = await fetchFn(`https://api.telegra.ph/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as TelegraphApiResponse<T>;
  if (!data.ok) throw new Error((data as TelegraphApiError).error);
  return (data as TelegraphApiOk<T>).result;
}

export async function createTelegraphPage(input: {
  title: string;
  markdown: string;
  fetchFn?: typeof fetch;
  authorName?: string;
}): Promise<string> {
  const fetchFn = input.fetchFn ?? fetch;
  const { access_token } = await telegraphPost<{ access_token: string }>(
    "createAccount",
    { short_name: "agent-bridge", author_name: input.authorName ?? "agent-bridge" },
    fetchFn,
  );
  const { url } = await telegraphPost<{ url: string }>(
    "createPage",
    {
      access_token,
      title: input.title,
      content: markdownToTelegraphNodes(input.markdown),
      return_content: false,
    },
    fetchFn,
  );
  return url;
}

// ---------------------------------------------------------------------------
// PoC entry point
// ---------------------------------------------------------------------------

const DEMO_MARKDOWN = `# Agent Bridge — CI Failure Report

**PR #42** on branch \`agent/work-17\` is blocked.

## Failing check

\`\`\`bash
npm test -- test/prMergeGate.test.ts
# exit code: 1
\`\`\`

## Root cause

The merge gate caught a missing _required_ field in the job payload:

- \`task_id\` was \`null\`
- \`repo\` was empty string
- \`head_sha\` did not match the PR head

## Next steps

1. Fix the payload builder in \`src/handlers/prMerge.ts\`
2. Re-run \`npm test\`
3. Push — CI re-triggers automatically

---

Do **not** weaken the merge gate check. The failing command and exit code must appear in any report.

| Field | Expected | Got |
|---|---|---|
| task_id | string | null |
| head_sha | abc123 | def456 |
`;

async function main() {
  console.log("shouldUseInstantView:", shouldUseInstantView(DEMO_MARKDOWN));
  console.log("Node count:", markdownToTelegraphNodes(DEMO_MARKDOWN).length);

  console.log("\nCalling Telegraph API...");
  const url = await createTelegraphPage({ title: "CI Failure Report", markdown: DEMO_MARKDOWN });
  console.log("\nTelegraph page URL:", url);
  console.log("Send this URL as a Telegram message — it opens in Instant View automatically.");
}

if (process.argv[1]?.endsWith("telegraph-spike.ts") || process.argv[1]?.endsWith("telegraph-spike.js")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
