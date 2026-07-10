import type { BridgeDb } from "./db.js";
import type { AdvisorConfidence, AdvisorRequest, AdvisorRequestMode } from "./advisorTypes.js";

export function redactAdvisorText(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/\b(token|api[_-]?key|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED TOKEN]");
}
function boundedParts(parts: string[], maxChars: number): string {
  const selected: string[] = [];
  let remaining = maxChars;
  for (const part of parts) {
    if (remaining <= 0) break;
    const clean = redactAdvisorText(part);
    const value = clean.slice(0, remaining);
    selected.push(value);
    remaining -= value.length + 2;
  }
  return selected.join("\n\n").slice(0, maxChars);
}
export function buildAdvisorContext(db: BridgeDb, input: {
  scopeKey: string; task: string; maxChars: number; evidence?: AdvisorRequest["evidence"];
}): string {
  const summary = db.getLatestConvSummary(input.scopeKey);
  const turns = db.getRecentConvTurns(input.scopeKey, 20, summary?.range_end_turn_id);
  const evidence = input.evidence;
  return boundedParts([
    `Task: ${input.task}`,
    ...(summary ? [`Conversation summary:\n${summary.summary_md}`] : []),
    ...[...turns].reverse().map((turn) => `${turn.role}: ${turn.text}`),
    ...(evidence?.diffSummary ? [`Diff summary:\n${evidence.diffSummary}`] : []),
    ...(evidence?.testOutput ? [`Test output:\n${evidence.testOutput}`] : []),
    ...(evidence?.constraints?.length ? [`Constraints:\n${evidence.constraints.join("\n")}`] : []),
    ...(evidence?.references?.length ? [`References:\n${evidence.references.join("\n")}`] : []),
  ], input.maxChars);
}
export function buildAdvisorPrompt(input: { mode: AdvisorRequestMode; activeProvider: string; activeModel: string | null; context: string }): string {
  return [
    "You are Agent Bridge's frontier advisor. Give the executor a concise, rigorous second opinion.",
    "You may inspect supplied evidence, but do not execute commands, edit files, approve, merge, deploy, delete, or send user messages.",
    `Review mode: ${input.mode}`,
    `Active executor: ${input.activeProvider}:${input.activeModel ?? "default"}`,
    input.context,
    "Return only JSON:",
    '{"advice_md":"...","risks":["..."],"suggested_next_steps":["..."],"confidence":"low|medium|high"}',
  ].join("\n\n");
}
function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  const candidate = fenced ?? trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
  return JSON.parse(candidate);
}
function boundedList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value.slice(0, 12).map((item) => item.slice(0, 1_200)) : null;
}
export function parseAdvisorOutput(raw: string): {
  adviceMd: string; risks: string[]; suggestedNextSteps: string[]; confidence: AdvisorConfidence;
} {
  try {
    const value = extractJson(raw) as Record<string, unknown>;
    const adviceMd = typeof value.advice_md === "string" ? value.advice_md.trim().slice(0, 12_000) : "";
    const risks = boundedList(value.risks);
    const suggestedNextSteps = boundedList(value.suggested_next_steps);
    const confidence = value.confidence;
    if (!adviceMd || !risks || !suggestedNextSteps || !["low", "medium", "high"].includes(String(confidence))) throw new Error("schema");
    return { adviceMd, risks, suggestedNextSteps, confidence: confidence as AdvisorConfidence };
  } catch {
    throw new Error("Invalid advisor output: expected structured JSON");
  }
}
