export type WorkerPromptKey =
  | "feature_plan"
  | "implementation_plan:create"
  | "implementation_plan:improve"
  | "defect_scan:scan"
  | "defect_scan:plan"
  | "defect_scan:triage"
  | "refactor_scan:scan"
  | "refactor_scan:plan"
  | "tdd_implementation:red_test"
  | "tdd_implementation:green_implementation"
  | "tdd_implementation:ci_fix"
  | "tdd_implementation:repair"
  | "orchestrated_task:plan"
  | "orchestrated_task:execute";

export type WorkerPromptSupplementKey =
  | "planning-and-task-breakdown"
  | "test-driven-development"
  | "incremental-implementation"
  | "code-review-and-quality"
  | "debugging-and-error-recovery"
  | "security-and-risk-gate"
  | "documentation-and-adrs";

export interface WorkerPromptDefinition {
  /** Existing or future DB prompt override key. */
  dbKey: WorkerPromptKey;
  /** Version-controlled bundled prompt path. */
  filePath: string;
  /** Distilled skill supplements to append when the prompt is loaded. */
  supplements: WorkerPromptSupplementKey[];
}

export interface WorkerPromptReader {
  readText(path: string): string | Promise<string>;
}

export interface LoadWorkerPromptOptions {
  /** Optional DB template. When provided, it should win over the bundled prompt file. */
  dbTemplate?: string | null;
  /** Allows tests or future callers to suppress supplement injection. */
  includeSupplements?: boolean;
}

export const WORKER_PROMPT_ROOT = "prompts/worker";
export const WORKER_PROMPT_SUPPLEMENT_ROOT = `${WORKER_PROMPT_ROOT}/supplements`;

export const WORKER_PROMPT_SUPPLEMENT_FILES: Record<WorkerPromptSupplementKey, string> = {
  "planning-and-task-breakdown": `${WORKER_PROMPT_SUPPLEMENT_ROOT}/planning-and-task-breakdown.md`,
  "test-driven-development": `${WORKER_PROMPT_SUPPLEMENT_ROOT}/test-driven-development.md`,
  "incremental-implementation": `${WORKER_PROMPT_SUPPLEMENT_ROOT}/incremental-implementation.md`,
  "code-review-and-quality": `${WORKER_PROMPT_SUPPLEMENT_ROOT}/code-review-and-quality.md`,
  "debugging-and-error-recovery": `${WORKER_PROMPT_SUPPLEMENT_ROOT}/debugging-and-error-recovery.md`,
  "security-and-risk-gate": `${WORKER_PROMPT_SUPPLEMENT_ROOT}/security-and-risk-gate.md`,
  "documentation-and-adrs": `${WORKER_PROMPT_SUPPLEMENT_ROOT}/documentation-and-adrs.md`,
};

export const WORKER_PROMPTS: Record<WorkerPromptKey, WorkerPromptDefinition> = {
  "feature_plan": {
    dbKey: "feature_plan",
    filePath: `${WORKER_PROMPT_ROOT}/feature-plan.md`,
    supplements: ["planning-and-task-breakdown", "test-driven-development", "incremental-implementation"],
  },
  "implementation_plan:create": {
    dbKey: "implementation_plan:create",
    filePath: `${WORKER_PROMPT_ROOT}/implementation-plan-create.md`,
    supplements: [
      "planning-and-task-breakdown",
      "test-driven-development",
      "incremental-implementation",
      "security-and-risk-gate",
      "documentation-and-adrs",
    ],
  },
  "implementation_plan:improve": {
    dbKey: "implementation_plan:improve",
    filePath: `${WORKER_PROMPT_ROOT}/implementation-plan-improve.md`,
    supplements: ["planning-and-task-breakdown", "test-driven-development", "security-and-risk-gate"],
  },
  "defect_scan:scan": {
    dbKey: "defect_scan:scan",
    filePath: `${WORKER_PROMPT_ROOT}/defect-scan.md`,
    supplements: ["code-review-and-quality", "debugging-and-error-recovery", "security-and-risk-gate"],
  },
  "defect_scan:plan": {
    dbKey: "defect_scan:plan",
    filePath: `${WORKER_PROMPT_ROOT}/defect-plan.md`,
    supplements: ["debugging-and-error-recovery", "test-driven-development", "planning-and-task-breakdown"],
  },
  "defect_scan:triage": {
    dbKey: "defect_scan:triage",
    filePath: `${WORKER_PROMPT_ROOT}/defect-triage.md`,
    supplements: ["code-review-and-quality", "security-and-risk-gate"],
  },
  "refactor_scan:scan": {
    dbKey: "refactor_scan:scan",
    filePath: `${WORKER_PROMPT_ROOT}/refactor-scan.md`,
    supplements: ["code-review-and-quality", "incremental-implementation"],
  },
  "refactor_scan:plan": {
    dbKey: "refactor_scan:plan",
    filePath: `${WORKER_PROMPT_ROOT}/refactor-plan.md`,
    supplements: ["incremental-implementation", "test-driven-development", "planning-and-task-breakdown"],
  },
  "tdd_implementation:red_test": {
    dbKey: "tdd_implementation:red_test",
    filePath: `${WORKER_PROMPT_ROOT}/tdd-red-test.md`,
    supplements: ["test-driven-development", "debugging-and-error-recovery"],
  },
  "tdd_implementation:green_implementation": {
    dbKey: "tdd_implementation:green_implementation",
    filePath: `${WORKER_PROMPT_ROOT}/tdd-green-implementation.md`,
    supplements: ["incremental-implementation", "test-driven-development", "security-and-risk-gate"],
  },
  "tdd_implementation:ci_fix": {
    dbKey: "tdd_implementation:ci_fix",
    filePath: `${WORKER_PROMPT_ROOT}/tdd-ci-fix.md`,
    supplements: ["debugging-and-error-recovery", "test-driven-development"],
  },
  "tdd_implementation:repair": {
    dbKey: "tdd_implementation:repair",
    filePath: `${WORKER_PROMPT_ROOT}/tdd-repair.md`,
    supplements: ["debugging-and-error-recovery", "incremental-implementation", "security-and-risk-gate"],
  },
  "orchestrated_task:plan": {
    dbKey: "orchestrated_task:plan",
    filePath: `${WORKER_PROMPT_ROOT}/orchestrated-plan.md`,
    supplements: ["planning-and-task-breakdown", "incremental-implementation", "security-and-risk-gate"],
  },
  "orchestrated_task:execute": {
    dbKey: "orchestrated_task:execute",
    filePath: `${WORKER_PROMPT_ROOT}/orchestrated-execute.md`,
    supplements: ["incremental-implementation", "test-driven-development", "security-and-risk-gate"],
  },
};

export function renderWorkerPrompt(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\$?\{([A-Za-z0-9_]+)\}/g, (match, key: string) => {
    if (!(key in variables)) return match;
    const value = variables[key];
    return value == null ? "" : String(value);
  });
}

export function appendWorkerPromptSupplements(basePrompt: string, supplementTexts: string[]): string {
  const nonEmpty = supplementTexts.map(text => text.trim()).filter(Boolean);
  if (nonEmpty.length === 0) return basePrompt.trim();

  return [
    basePrompt.trim(),
    "",
    "---",
    "",
    "# Worker skill supplements",
    "",
    ...nonEmpty.map((text, index) => `## Supplement ${index + 1}\n\n${text}`),
  ].join("\n").trim();
}

export async function loadWorkerPrompt(
  key: WorkerPromptKey,
  variables: Record<string, unknown>,
  reader: WorkerPromptReader,
  options: LoadWorkerPromptOptions = {},
): Promise<string> {
  const definition = WORKER_PROMPTS[key];
  const baseTemplate = options.dbTemplate?.trim()
    ? options.dbTemplate
    : await reader.readText(definition.filePath);

  const renderedBase = renderWorkerPrompt(baseTemplate, variables);

  if (options.includeSupplements === false) {
    return renderedBase.trim();
  }

  const supplementTexts = await Promise.all(
    definition.supplements.map(supplement => reader.readText(WORKER_PROMPT_SUPPLEMENT_FILES[supplement])),
  );

  return appendWorkerPromptSupplements(renderedBase, supplementTexts);
}
