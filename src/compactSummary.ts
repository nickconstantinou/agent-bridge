/**
 * PURPOSE: Helpers for /compact — builds the LLM summarization prompt and tombstone fallback.
 * NEIGHBORS: src/engine.ts (compact handler)
 */

import type { ProjectMemoryCandidate } from "./projectMemory.js";

export type CompactProfile = "engineering" | "companion";

export const COMPACT_PROMPT_MAX_CHARS = 18_000;
export const COMPACT_TIMEOUT_MS = 60_000;
export const COMPACT_CHUNK_MAX_CHARS = 16_000;
export const COMPACT_PARALLELISM = 2;

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function compactPromptMaxChars(): number {
  return positiveIntFromEnv("BRIDGE_COMPACT_PROMPT_MAX_CHARS", COMPACT_PROMPT_MAX_CHARS);
}

export function compactChunkMaxChars(): number {
  return positiveIntFromEnv("BRIDGE_COMPACT_CHUNK_MAX_CHARS", COMPACT_CHUNK_MAX_CHARS);
}

export function compactParallelism(): number {
  return Math.min(8, positiveIntFromEnv("BRIDGE_COMPACT_PARALLELISM", COMPACT_PARALLELISM));
}

export type CompactTurn = { id?: number; role: string; text: string };

const ENGINEERING_DURABLE_FACTS_GUIDANCE =
  "<repo, branch, active PR/issue numbers, file paths, job IDs, architectural decisions>";
const COMPANION_DURABLE_FACTS_GUIDANCE =
  "<user preferences, constraints, decisions, named projects, recurring context, " +
  "health/training/travel/home/work context, technical/project details where relevant>";

function summaryFormatBlock(profile: CompactProfile): string {
  const durableFacts = profile === "companion"
    ? COMPANION_DURABLE_FACTS_GUIDANCE
    : ENGINEERING_DURABLE_FACTS_GUIDANCE;
  return `Current objective:
- <one line>

Durable facts:
- ${durableFacts}

Open state:
- <unresolved questions, blocked items, pending approvals>`;
}

function jsonOutputHeader(profile: CompactProfile): string {
  return `You are summarising a Telegram conversation with an AI ${profile === "companion" ? "companion" : "coding"} assistant.
Output ONLY a single JSON object — no preamble, no explanation, no markdown fence:

{
  "summary_md": "<markdown summary described below, as one string using \\n line breaks>",
  "memory_candidates": [
    { "type": "decision", "scope": "project", "text": "<durable standalone fact>", "confidence": 0.9 }
  ]
}

summary_md must use this exact markdown format:

${summaryFormatBlock(profile)}

Be dense. Omit pleasantries, filler turns, and completed sub-steps.

memory_candidates: durable facts, decisions, bug fixes, conventions, or unresolved
TODOs that a future agent should know standalone, outside this conversation.
Use [] when nothing durable should be stored. Do not store secrets, tokens,
passwords, private personal details, raw logs, transient status, or generic
summaries. Allowed type values: decision, bug, bugfix, convention, todo, note.
Allowed scope values: project, chat, global.`;
}

export function buildCompactSummaryPrompt(
  turns: CompactTurn[],
  profile: CompactProfile = "engineering",
  maxChars = compactPromptMaxChars(),
): string {
  const header = `${jsonOutputHeader(profile)}\n\n--- Conversation ---\n`;
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
  maxChars = compactChunkMaxChars(),
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
  profile: CompactProfile = "engineering",
  maxChars = compactPromptMaxChars(),
): string {
  const header = jsonOutputHeader(profile);
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
    header,
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
  const fixedLength = header.length + trimmedPrevious.length + 400;
  const bodyBudget = Math.max(500, maxChars - fixedLength);
  const trimmedBody = body.length > bodyBudget
    ? body.slice(-bodyBudget)
    : body;
  return [
    header,
    "",
    "Merge these compact summaries into one updated durable conversation summary.",
    trimmedPrevious,
    "[... earlier chunk summaries truncated to fit reduce budget ...]",
    trimmedBody,
    "",
    "Summarise now:",
  ].join("\n");
}

export type CompactOutput = {
  summaryMd: string;
  memoryCandidates: ProjectMemoryCandidate[];
};

function stripJsonFence(text: string): string {
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1].trim() : text;
}

function extractTopLevelJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth++;
    } else if (char === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return depth === 0 ? objects : [];
}

function isHarmlessJsonWrapper(text: string): boolean {
  const normalized = text
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
  if (!normalized) return true;
  return /^(?:sure[,.!]?\s*)?(?:here is (?:the )?(?:corrected )?(?:json|result|output)[:.]?)$/i.test(normalized);
}

function parseCompactObject(text: string): CompactOutput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const summaryMd = obj.summary_md;
  if (typeof summaryMd !== "string" || summaryMd.trim().length === 0) return null;
  if (!Array.isArray(obj.memory_candidates)) return null;
  if (obj.memory_candidates.some((item) => !item || typeof item !== "object" || Array.isArray(item))) return null;
  return {
    summaryMd,
    memoryCandidates: obj.memory_candidates as ProjectMemoryCandidate[],
  };
}

/**
 * Parses the structured `{ summary_md, memory_candidates }` compact output.
 * Returns null on any parse/shape failure so the caller can fall back to a
 * tombstone rather than store a broken or partial result.
 */
export function parseCompactOutput(raw: string): CompactOutput | null {
  const text = raw.trim();
  if (!text) return null;
  const direct = parseCompactObject(stripJsonFence(text));
  if (direct) return direct;

  const objects = extractTopLevelJsonObjects(text);
  if (objects.length !== 1) return null;
  const candidate = objects[0];
  const start = text.indexOf(candidate);
  if (!isHarmlessJsonWrapper(text.slice(0, start)) ||
      !isHarmlessJsonWrapper(text.slice(start + candidate.length))) return null;
  return parseCompactObject(candidate);
}

export function buildCompactRepairPrompt(
  invalidResponse: string,
  profile: CompactProfile = "engineering",
  maxChars = compactPromptMaxChars(),
): string {
  const header = [
    jsonOutputHeader(profile),
    "",
    "Correct the invalid structured response below. Preserve its intended facts, but output only one schema-valid JSON object.",
    "Do not add explanation, markdown fences, tools, or reasoning.",
    "",
    "--- Invalid structured response ---",
  ].join("\n");
  const footer = "\n--- End invalid response ---\n\nReturn corrected JSON now:";
  const budget = Math.max(0, maxChars - header.length - footer.length);
  return header + "\n" + invalidResponse.slice(0, budget) + footer;
}
