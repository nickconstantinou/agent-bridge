/**
 * PURPOSE: Pure helpers for worker implementation-plan execution contracts and compact execution prompt context.
 * NEIGHBORS: src/workerPrompts.ts, src/workerPromptFailureContext.ts, src/handlers/implementationPlan.ts
 */

import { truncateWorkerPromptValue } from "./workerPrompts.js";
import { buildWorkerFailureContext } from "./workerPromptFailureContext.js";

export interface WorkerExecutionContract {
  target_files: string[];
  test_files: string[];
  phase_order: string[];
  red_test_command: string;
  verification_command: string;
  risk_level: string;
  human_decision_required: boolean;
  out_of_scope: string[];
  notes_for_red_pass: string;
  notes_for_green_pass: string;
}

export type ExecutionContractResult =
  | { ok: true; contract: WorkerExecutionContract }
  | { ok: false; error: string };

export interface BuildExecutionPromptContextInput {
  planText: string;
  executionContract: WorkerExecutionContract;
  phase: "red" | "green" | "ci_fix" | "repair";
  failureOutput?: string | null;
  maxPlanChars?: number;
  maxFailureChars?: number;
}

export interface ExecutionPromptContext {
  execution_contract: string;
  plan_text: string;
  failure_output: string;
}

const REQUIRED_STRING_ARRAY_FIELDS = ["target_files", "test_files", "phase_order", "out_of_scope"] as const;
const REQUIRED_STRING_FIELDS = [
  "red_test_command",
  "verification_command",
  "risk_level",
  "notes_for_red_pass",
  "notes_for_green_pass",
] as const;

function findExecutionContractSection(planText: string): string | null {
  const match = /^##\s+Execution Contract\s*$/gim.exec(planText);
  if (!match) return null;

  const sectionStart = match.index + match[0].length;
  const rest = planText.slice(sectionStart);
  const nextHeading = /^##\s+/gim.exec(rest);
  return (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim();
}

function extractJsonCandidate(section: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(section);
  if (fenced?.[1]?.trim()) return fenced[1].trim();

  const objectStart = section.indexOf("{");
  const objectEnd = section.lastIndexOf("}");
  if (objectStart < 0 || objectEnd <= objectStart) return null;
  return section.slice(objectStart, objectEnd + 1).trim();
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function validateContract(value: unknown): ExecutionContractResult {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    return { ok: false, error: "Execution contract JSON must be an object" };
  }

  const candidate = value as Record<string, unknown>;
  for (const field of REQUIRED_STRING_ARRAY_FIELDS) {
    if (!isStringArray(candidate[field])) {
      return { ok: false, error: `Execution contract field ${field} must be a string array` };
    }
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof candidate[field] !== "string") {
      return { ok: false, error: `Execution contract field ${field} must be a string` };
    }
  }

  if (typeof candidate.human_decision_required !== "boolean") {
    return { ok: false, error: "Execution contract field human_decision_required must be a boolean" };
  }

  return {
    ok: true,
    contract: {
      target_files: candidate.target_files,
      test_files: candidate.test_files,
      phase_order: candidate.phase_order,
      red_test_command: candidate.red_test_command,
      verification_command: candidate.verification_command,
      risk_level: candidate.risk_level,
      human_decision_required: candidate.human_decision_required,
      out_of_scope: candidate.out_of_scope,
      notes_for_red_pass: candidate.notes_for_red_pass,
      notes_for_green_pass: candidate.notes_for_green_pass,
    },
  };
}

export function extractExecutionContract(planText: string): ExecutionContractResult {
  const section = findExecutionContractSection(planText);
  if (!section) return { ok: false, error: "Implementation plan is missing an Execution Contract section" };

  const jsonCandidate = extractJsonCandidate(section);
  if (!jsonCandidate) return { ok: false, error: "Execution Contract section does not contain JSON" };

  try {
    return validateContract(JSON.parse(jsonCandidate));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Execution Contract JSON is invalid: ${message}` };
  }
}

function buildContractPlanExcerpt(contract: WorkerExecutionContract, phase: BuildExecutionPromptContextInput["phase"]): string {
  const notes = phase === "red" ? contract.notes_for_red_pass : contract.notes_for_green_pass;
  return JSON.stringify({
    target_files: contract.target_files,
    test_files: contract.test_files,
    phase_order: contract.phase_order,
    red_test_command: contract.red_test_command,
    verification_command: contract.verification_command,
    risk_level: contract.risk_level,
    human_decision_required: contract.human_decision_required,
    out_of_scope: contract.out_of_scope,
    notes_for_red_pass: contract.notes_for_red_pass,
    notes_for_green_pass: contract.notes_for_green_pass,
    current_phase_notes: notes,
  }, null, 2);
}

export function buildExecutionPromptContext(input: BuildExecutionPromptContextInput): ExecutionPromptContext {
  const planExcerpt = buildContractPlanExcerpt(input.executionContract, input.phase);
  return {
    execution_contract: JSON.stringify(input.executionContract, null, 2),
    plan_text: truncateWorkerPromptValue(planExcerpt, input.maxPlanChars ?? 2_400),
    failure_output: buildWorkerFailureContext({
      failureOutput: input.failureOutput,
      maxChars: input.maxFailureChars ?? 6_000,
    }),
  };
}
