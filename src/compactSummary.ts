/**
 * PURPOSE: Helpers for /compact — builds the LLM summarization prompt and tombstone fallback.
 * NEIGHBORS: src/engine.ts (compact handler)
 */

export const COMPACT_PROMPT_MAX_CHARS = 7_500;
export const COMPACT_TIMEOUT_MS = 60_000;

const SUMMARY_SYSTEM_HEADER = `You are summarising a Telegram conversation with an AI coding assistant.
Output ONLY the summary in this exact format — no preamble, no explanation:

Current objective:
- <one line>

Durable facts:
- <repo, branch, active PR/issue numbers, file paths, job IDs, decisions>

Open state:
- <unresolved questions, blocked items, pending approvals>

Be dense. Omit pleasantries, filler turns, and completed sub-steps.`;

export function buildCompactSummaryPrompt(
  turns: Array<{ role: string; text: string }>,
  maxChars = COMPACT_PROMPT_MAX_CHARS,
): string {
  const header = `${SUMMARY_SYSTEM_HEADER}\n\n--- Conversation ---\n`;
  const footer = `\n--- End ---\n\nSummarise now:`;
  const budget = maxChars - header.length - footer.length;

  const lines: string[] = [];
  let used = 0;
  for (const t of turns) {
    const label = t.role === "user" ? "User" : "Assistant";
    const line = `${label}: ${t.text}\n`;
    if (used + line.length > budget) {
      lines.push(`[... earlier turns truncated to fit context budget ...]`);
      break;
    }
    lines.push(line);
    used += line.length;
  }

  return header + lines.join("") + footer;
}

export function buildTombstone(
  turns: Array<{ role: string; text: string }>,
  cli: string,
): string {
  const userCount = turns.filter((t) => t.role === "user").length;
  const assistantCount = turns.filter((t) => t.role === "assistant").length;
  const lastUser = turns.filter((t) => t.role === "user").pop()?.text ?? "none";
  return [
    `[Compacted at ${new Date().toISOString()}]`,
    `${turns.length} turn${turns.length === 1 ? "" : "s"} captured (${userCount} user, ${assistantCount} assistant).`,
    `CLI at compact time: ${cli}.`,
    `Last user message: ${lastUser}`,
  ].join("\n");
}
