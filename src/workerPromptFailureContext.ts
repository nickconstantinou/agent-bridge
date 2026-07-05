/**
 * PURPOSE: Build compact failure excerpts for worker prompt repair and CI-fix phases.
 * NEIGHBORS: src/workerPromptContracts.ts, src/workerPrompts.ts
 */

import { truncateWorkerPromptValue } from "./workerPrompts.js";

export interface WorkerFailureContextInput {
  failureOutput?: string | null;
  maxChars?: number;
}

const FAILURE_LINE_PATTERNS = [
  /\b(error|exception|failed|failure|assertion)\b/i,
  /\b(expected|received|actual)\b/i,
  /\btypeerror|referenceerror|syntaxerror\b/i,
  /\btest\b.*\bfailed\b/i,
];

export function buildWorkerFailureContext(input: WorkerFailureContextInput): string {
  const text = input.failureOutput == null ? "" : String(input.failureOutput);
  const maxChars = input.maxChars ?? 6_000;
  if (!text.trim()) return "";

  const lines = text.split(/\r?\n/);
  const selected = new Set<number>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!FAILURE_LINE_PATTERNS.some(pattern => pattern.test(line))) continue;
    for (let offset = -2; offset <= 4; offset += 1) {
      const selectedIndex = index + offset;
      if (selectedIndex >= 0 && selectedIndex < lines.length) selected.add(selectedIndex);
    }
  }

  const focused = [...selected]
    .sort((a, b) => a - b)
    .map(index => lines[index])
    .join("\n")
    .trim();

  const fallback = lines.slice(-80).join("\n").trim();
  return truncateWorkerPromptValue(focused || fallback || text, maxChars);
}
