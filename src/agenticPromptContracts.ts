/**
 * PURPOSE: Own the versioned source-controlled prompt registry for Engineering Worker roles and modes.
 * INPUTS: Canonical prompt keys, bounded render variables, and a prompt-file reader.
 * OUTPUTS: Effective built-in prompt text with stable template identity and invocation-specific rendered identity.
 * NEIGHBORS: src/workerPrompts.ts, src/advisor.ts, src/handlers/*, prompts/worker/roles/*
 */

import { createHash } from "node:crypto";
import {
  renderWorkerPrompt,
  truncateWorkerPromptValue,
  type WorkerPromptReader,
} from "./workerPrompts.js";

export type AgentRole = "technical_lead" | "code_worker" | "documentation_steward";

export type AgenticPromptKey =
  | "technical_lead:requirements"
  | "technical_lead:issue_validation"
  | "technical_lead:issue_authoring"
  | "technical_lead:planning"
  | "technical_lead:planning_repair:execution_contract"
  | "technical_lead:planning_repair:red_tests"
  | "technical_lead:executor_guidance"
  | "technical_lead:implementation_review"
  | "technical_lead:operations_review"
  | "technical_lead:pr_readiness"
  | "code_worker:scan:defect"
  | "code_worker:scan:refactor"
  | "code_worker:investigate"
  | "code_worker:red"
  | "code_worker:green"
  | "code_worker:repair"
  | "code_worker:verify"
  | "documentation_steward:impact"
  | "documentation_steward:author"
  | "documentation_steward:validate"
  | "documentation_steward:maintenance";

export interface AgenticPromptContract {
  key: AgenticPromptKey;
  version: 1;
  role: AgentRole;
  mode: string;
  filePath: string;
  outputContract: string;
  requiredVariables: readonly string[];
  required: true;
  source: "builtin";
  /** Canonical role prompts are reviewable source artifacts, never mutable DB text. */
  allowDatabaseOverride: false;
  compatibilityAliases: string[];
}

export interface EffectiveAgenticPrompt {
  key: AgenticPromptKey;
  version: 1;
  role: AgentRole;
  mode: string;
  source: "builtin";
  content: string;
  /** Stable identity of the reviewed source-controlled template. */
  contentHash: string;
  /** Invocation-specific identity after bounded context rendering. */
  renderedContentHash: string;
}

const ROOT = "prompts/worker/roles";
const MAX_VARIABLE_CHARS = 16_000;
const MAX_RENDERED_PROMPT_CHARS = 96_000;

export const AGENTIC_PROMPT_REQUIRED_VARIABLES: Record<AgenticPromptKey, readonly string[]> = {
  "technical_lead:requirements": [
    "repository", "request", "source_context", "evidence_catalog", "known_decisions",
  ],
  "technical_lead:issue_validation": [
    "change_type", "candidate_issue", "evidence_catalog", "decisions",
  ],
  "technical_lead:issue_authoring": [
    "change_type", "validated_requirements", "evidence_catalog", "decisions",
  ],
  "technical_lead:planning": [
    "canonical_issue", "repository_evidence", "documentation_impact", "constraints",
  ],
  "technical_lead:planning_repair:execution_contract": ["validation_errors", "original_plan"],
  "technical_lead:planning_repair:red_tests": [
    "validation_errors", "canonical_issue", "original_plan", "repository_evidence",
  ],
  "technical_lead:executor_guidance": [
    "canonical_issue", "approved_plan", "blocked_evidence", "repository_evidence",
  ],
  "technical_lead:implementation_review": [
    "canonical_issue", "approved_plan", "implementation_evidence", "verification_evidence",
    "documentation_evidence",
  ],
  "technical_lead:operations_review": [
    "issue_and_plan", "implementation_evidence", "operations_evidence",
  ],
  "technical_lead:pr_readiness": [
    "issue_and_plan", "implementation_review", "operations_review", "documentation_validation",
    "verification_evidence", "pr_evidence",
  ],
  "code_worker:scan:defect": ["repository", "scan_scope", "repository_evidence"],
  "code_worker:scan:refactor": ["repository", "scan_scope", "repository_evidence"],
  "code_worker:investigate": ["target", "questions", "repository_evidence"],
  "code_worker:red": ["canonical_issue", "approved_packet", "repository_state"],
  "code_worker:green": ["canonical_issue", "approved_packet", "red_evidence"],
  "code_worker:repair": ["approved_packet", "repair_evidence", "repository_state"],
  "code_worker:verify": ["verification_contract", "repository_state"],
  "documentation_steward:impact": [
    "issue_and_plan", "documentation_manifest", "change_evidence",
  ],
  "documentation_steward:author": [
    "documentation_impact", "implementation_context", "path_policy",
  ],
  "documentation_steward:validate": [
    "documentation_impact", "implementation_evidence", "documents",
  ],
  "documentation_steward:maintenance": [
    "documentation_manifest", "documentation_inventory", "implementation_evidence",
  ],
};

function contract(
  key: AgenticPromptKey,
  role: AgentRole,
  mode: string,
  fileName: string,
  outputContract: string,
  compatibilityAliases: string[] = [],
): AgenticPromptContract {
  return {
    key,
    version: 1,
    role,
    mode,
    filePath: `${ROOT}/${fileName}`,
    outputContract,
    requiredVariables: AGENTIC_PROMPT_REQUIRED_VARIABLES[key],
    required: true,
    source: "builtin",
    allowDatabaseOverride: false,
    compatibilityAliases,
  };
}

export const AGENTIC_PROMPT_CONTRACTS: Record<AgenticPromptKey, AgenticPromptContract> = {
  "technical_lead:requirements": contract(
    "technical_lead:requirements", "technical_lead", "requirements",
    "technical-lead-requirements.md", "requirements_discovery_v1",
  ),
  "technical_lead:issue_validation": contract(
    "technical_lead:issue_validation", "technical_lead", "issue_validation",
    "technical-lead-issue-validation.md", "issue_validation_v1",
  ),
  "technical_lead:issue_authoring": contract(
    "technical_lead:issue_authoring", "technical_lead", "issue_authoring",
    "technical-lead-issue-authoring.md", "canonical_issue_v1",
  ),
  "technical_lead:planning": contract(
    "technical_lead:planning", "technical_lead", "planning",
    "technical-lead-planning.md", "implementation_plan_v2",
    ["implementation_plan:create", "implementation_plan:improve", "orchestrated_task:plan"],
  ),
  "technical_lead:planning_repair:execution_contract": contract(
    "technical_lead:planning_repair:execution_contract", "technical_lead", "planning_repair",
    "technical-lead-planning-execution-contract-repair.md", "execution_contract_repair_v1",
    ["implementation_plan:contract_repair"],
  ),
  "technical_lead:planning_repair:red_tests": contract(
    "technical_lead:planning_repair:red_tests", "technical_lead", "planning_repair",
    "technical-lead-planning-red-tests-repair.md", "red_test_repair_v1",
  ),
  "technical_lead:executor_guidance": contract(
    "technical_lead:executor_guidance", "technical_lead", "executor_guidance",
    "technical-lead-executor-guidance.md", "executor_guidance_v1",
  ),
  "technical_lead:implementation_review": contract(
    "technical_lead:implementation_review", "technical_lead", "implementation_review",
    "technical-lead-implementation-review.md", "implementation_review_v1",
  ),
  "technical_lead:operations_review": contract(
    "technical_lead:operations_review", "technical_lead", "operations_review",
    "technical-lead-operations-review.md", "operations_review_v1",
  ),
  "technical_lead:pr_readiness": contract(
    "technical_lead:pr_readiness", "technical_lead", "pr_readiness",
    "technical-lead-pr-readiness.md", "pr_readiness_v1",
  ),
  "code_worker:scan:defect": contract(
    "code_worker:scan:defect", "code_worker", "scan",
    "code-worker-defect-scan.md", "defect_candidates_v1",
    ["defect_scan:scan"],
  ),
  "code_worker:scan:refactor": contract(
    "code_worker:scan:refactor", "code_worker", "scan",
    "code-worker-refactor-scan.md", "refactor_candidates_v1",
    ["refactor_scan:scan"],
  ),
  "code_worker:investigate": contract(
    "code_worker:investigate", "code_worker", "investigate",
    "code-worker-investigate.md", "investigation_evidence_v1",
  ),
  "code_worker:red": contract(
    "code_worker:red", "code_worker", "red",
    "code-worker-red.md", "red_execution_evidence_v1",
    ["tdd_implementation:red_test"],
  ),
  "code_worker:green": contract(
    "code_worker:green", "code_worker", "green",
    "code-worker-green.md", "green_execution_evidence_v1",
    ["tdd_implementation:green_implementation", "orchestrated_task:execute"],
  ),
  "code_worker:repair": contract(
    "code_worker:repair", "code_worker", "repair",
    "code-worker-repair.md", "repair_evidence_v1",
    ["tdd_implementation:repair", "tdd_implementation:ci_fix"],
  ),
  "code_worker:verify": contract(
    "code_worker:verify", "code_worker", "verify",
    "code-worker-verify.md", "verification_evidence_v1",
  ),
  "documentation_steward:impact": contract(
    "documentation_steward:impact", "documentation_steward", "impact",
    "documentation-steward-impact.md", "documentation_impact_v1",
  ),
  "documentation_steward:author": contract(
    "documentation_steward:author", "documentation_steward", "author",
    "documentation-steward-author.md", "documentation_authoring_evidence_v1",
  ),
  "documentation_steward:validate": contract(
    "documentation_steward:validate", "documentation_steward", "validate",
    "documentation-steward-validate.md", "documentation_validation_v1",
  ),
  "documentation_steward:maintenance": contract(
    "documentation_steward:maintenance", "documentation_steward", "maintenance",
    "documentation-steward-maintenance.md", "documentation_maintenance_v1",
  ),
};

export function getAgenticPromptContract(key: AgenticPromptKey): AgenticPromptContract {
  return AGENTIC_PROMPT_CONTRACTS[key];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function loadAgenticPrompt(
  key: AgenticPromptKey,
  variables: Record<string, unknown>,
  reader: WorkerPromptReader,
): Promise<EffectiveAgenticPrompt> {
  const promptContract = getAgenticPromptContract(key);
  const missingVariables = promptContract.requiredVariables.filter(name => !(name in variables));
  if (missingVariables.length > 0) {
    throw new Error(`Missing required variables for ${key}: ${missingVariables.join(", ")}`);
  }

  const template = (await reader.readText(promptContract.filePath)).trim();
  const boundedVariables = Object.fromEntries(
    Object.entries(variables).map(([name, value]) => [
      name,
      truncateWorkerPromptValue(value, MAX_VARIABLE_CHARS),
    ]),
  );
  const content = renderWorkerPrompt(template, boundedVariables).trim();
  if (content.length > MAX_RENDERED_PROMPT_CHARS) {
    throw new Error(`Rendered prompt ${key} exceeds ${MAX_RENDERED_PROMPT_CHARS} characters`);
  }

  return {
    key,
    version: promptContract.version,
    role: promptContract.role,
    mode: promptContract.mode,
    source: "builtin",
    content,
    contentHash: sha256(template),
    renderedContentHash: sha256(content),
  };
}
