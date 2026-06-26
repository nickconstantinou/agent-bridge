/**
 * PURPOSE: Post-turn durable memory candidate extraction.
 * INPUTS: User prompt and cleaned assistant text.
 * OUTPUTS: Strict JSON-only extraction prompt and parsed ProjectMemoryCandidate rows.
 * NEIGHBORS: src/engine.ts, src/projectMemory.ts
 */

import type { ProjectMemoryCandidate } from "./projectMemory.js";

const EXTRACTOR_TEXT_LIMIT = 4_000;

function boundText(text: string, limit = EXTRACTOR_TEXT_LIMIT): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 15).trimEnd()}... [truncated]`;
}

export function buildPostTurnMemoryExtractionPrompt(input: {
  userPrompt: string;
  assistantText: string;
}): string {
  const userPrompt = boundText(input.userPrompt, 2_000);
  const assistantText = boundText(input.assistantText, EXTRACTOR_TEXT_LIMIT);
  return [
    "Extract durable Agent Bridge project memory candidates from this completed turn.",
    "",
    "Output ONLY a JSON array. Use [] when nothing durable should be stored.",
    "",
    "Store only facts, decisions, bug fixes, conventions, or unresolved TODOs that future coding agents should know.",
    "Do not store secrets, tokens, passwords, private personal details, raw logs, transient status, or generic summaries.",
    "Each item must have: type, scope, text, confidence.",
    "Allowed type values: decision, bug, bugfix, convention, todo, note.",
    "Allowed scope values: project, chat, global. Prefer project.",
    "Keep text concise, specific, and standalone.",
    "",
    "--- User prompt ---",
    userPrompt,
    "",
    "--- Assistant response ---",
    assistantText,
  ].join("\n");
}

export function parsePostTurnMemoryCandidates(text: string): ProjectMemoryCandidate[] {
  const raw = text.trim();
  if (!raw) return [];

  const jsonText = stripJsonFence(raw);
  try {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item === "object") as ProjectMemoryCandidate[];
  } catch {
    return [];
  }
}

function stripJsonFence(text: string): string {
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1].trim() : text;
}
