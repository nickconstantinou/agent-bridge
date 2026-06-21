/**
 * PURPOSE: Helpers for /compact — builds the LLM summarization prompt and tombstone fallback.
 * NEIGHBORS: src/engine.ts (compact handler)
 */

export const COMPACT_PROMPT_MAX_CHARS = 7_500;
export const COMPACT_TIMEOUT_MS = 60_000;
export const COMPACT_CHUNK_MAX_CHARS = 6_500;

export type CompactTurn = { id?: number; role: string; text: string };

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
  turns: CompactTurn[],
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

export function chunkCompactTurns(
  turns: CompactTurn[],
  maxChars = COMPACT_CHUNK_MAX_CHARS,
): CompactTurn[][] {
  const chunks: CompactTurn[][] = [];
  let current: CompactTurn[] = [];
  let used = 0;

  for (const turn of turns) {
    const label = turn.role === "user" ? "User" : "Assistant";
    const lineLength = `${label}: ${turn.text}\n`.length;
    if (current.length > 0 && used + lineLength > maxChars) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(turn);
    used += lineLength;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function buildCompactReducePrompt(
  previousSummary: string | null,
  chunkSummaries: Array<{ startId: number; endId: number; summary: string }>,
  maxChars = COMPACT_PROMPT_MAX_CHARS,
): string {
  const previousText = previousSummary?.trim();
  const previous = previousText
    ? `--- Previous compact summary ---\n${previousText}\n\n`
    : "";
  const body = chunkSummaries
    .map((chunk, idx) => [
      `--- Chunk ${idx + 1} (${chunk.startId}-${chunk.endId}) ---`,
      chunk.summary.trim(),
    ].join("\n"))
    .join("\n\n");
  const prompt = [
    SUMMARY_SYSTEM_HEADER,
    "",
    "Merge these compact summaries into one updated durable conversation summary.",
    "Preserve current objectives, durable facts, decisions, open state, file paths, commands, PR/issue IDs, and unresolved work.",
    "",
    previous + body,
    "",
    "Summarise now:",
  ].join("\n");

  if (prompt.length <= maxChars) return prompt;
  const previousBudget = previousText ? Math.min(2_000, Math.floor(maxChars * 0.3)) : 0;
  const trimmedPrevious = previousText
    ? `--- Previous compact summary ---\n[... earlier previous summary truncated ...]\n${previousText.slice(-previousBudget)}\n\n`
    : "";
  const fixedLength = SUMMARY_SYSTEM_HEADER.length + trimmedPrevious.length + 400;
  const bodyBudget = Math.max(500, maxChars - fixedLength);
  const trimmedBody = body.length > bodyBudget
    ? body.slice(-bodyBudget)
    : body;
  return [
    SUMMARY_SYSTEM_HEADER,
    "",
    "Merge these compact summaries into one updated durable conversation summary.",
    trimmedPrevious,
    "[... earlier chunk summaries truncated to fit reduce budget ...]",
    trimmedBody,
    "",
    "Summarise now:",
  ].join("\n");
}

export function buildTombstone(
  turns: CompactTurn[],
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
