import { redactAdvisorText } from "./advisorPrompt.js";

export const WORKER_BLOCKED_RESULT_MARKER = "AGENT_BRIDGE_BLOCKED_RESULT:";

export interface WorkerBlockedResult {
  status: "BLOCKED";
  reason: "NEEDS_ADVISOR";
  hypothesis: string;
  attemptedSteps: string[];
  failingEvidence: string;
  relevantFiles: string[];
  decisionNeeded: string;
}

function boundedText(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid worker blocked result: ${field} is required`);
  }
  return redactAdvisorText(value.trim()).slice(0, maxChars);
}

function boundedList(value: unknown, field: string, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Invalid worker blocked result: ${field} must be a string array`);
  }
  return value
    .slice(0, maxItems)
    .map((item) => redactAdvisorText(item.trim()).slice(0, maxChars))
    .filter(Boolean);
}

function extractMarkedJson(output: string): string | null {
  const markerIndex = output.indexOf(WORKER_BLOCKED_RESULT_MARKER);
  if (markerIndex < 0) return null;
  const suffix = output.slice(markerIndex + WORKER_BLOCKED_RESULT_MARKER.length).trim();
  const fenced = suffix.match(/^```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  const candidate = fenced ?? suffix;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Invalid worker blocked result: expected JSON object after marker");
  return candidate.slice(start, end + 1);
}

export function parseWorkerBlockedResult(output: string): WorkerBlockedResult | null {
  const json = extractMarkedJson(output);
  if (json == null) return null;

  let value: Record<string, unknown>;
  try {
    value = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new Error("Invalid worker blocked result: malformed JSON");
  }

  if (value.status !== "BLOCKED" || value.reason !== "NEEDS_ADVISOR") {
    throw new Error("Invalid worker blocked result: expected BLOCKED / NEEDS_ADVISOR");
  }

  return {
    status: "BLOCKED",
    reason: "NEEDS_ADVISOR",
    hypothesis: boundedText(value.hypothesis, "hypothesis", 2_000),
    attemptedSteps: boundedList(value.attempted_steps, "attempted_steps", 12, 800),
    failingEvidence: boundedText(value.failing_evidence, "failing_evidence", 6_000),
    relevantFiles: boundedList(value.relevant_files, "relevant_files", 24, 500),
    decisionNeeded: boundedText(value.decision_needed, "decision_needed", 2_000),
  };
}

export function formatWorkerBlockedResult(result: WorkerBlockedResult): string {
  return [
    `Hypothesis: ${result.hypothesis}`,
    `Attempted steps:\n${result.attemptedSteps.map((step) => `- ${step}`).join("\n") || "- none reported"}`,
    `Failing evidence:\n${result.failingEvidence}`,
    `Relevant files:\n${result.relevantFiles.map((file) => `- ${file}`).join("\n") || "- none reported"}`,
    `Decision needed: ${result.decisionNeeded}`,
  ].join("\n\n");
}
