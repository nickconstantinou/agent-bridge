export type WorkerPromptKey =
  | "feature_plan"
  | "implementation_plan:create"
  | "implementation_plan:improve"
  | "implementation_plan:contract_repair"
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

export interface WorkerPromptBudget {
  /** Soft cap used by tests/telemetry; do not truncate final instructions blindly. */
  maxPromptChars: number;
  /** Total supplement budget for this prompt. Supplements are phase-specific and capped before append. */
  maxSupplementChars: number;
  /** Per-placeholder input caps applied before rendering. */
  variableLimits: Partial<Record<string, number>>;
}

export interface WorkerPromptDefinition {
  /** Existing or future DB prompt override key. */
  dbKey: WorkerPromptKey;
  /** Version-controlled bundled prompt path. */
  filePath: string;
  /** Distilled skill supplements to append when the bundled prompt is loaded. */
  supplements: WorkerPromptSupplementKey[];
  /** Prompt-budget policy for this phase. */
  budget: WorkerPromptBudget;
}

export interface WorkerPromptReader {
  readText(path: string): string | Promise<string>;
}

export interface LoadWorkerPromptOptions {
  /** Optional DB template. When provided, it wins over the bundled prompt file. */
  dbTemplate?: string | null;
  /** Allows tests or future callers to suppress supplement injection. */
  includeSupplements?: boolean;
  /** DB overrides are assumed complete by default; opt in only if an override needs bundled supplements. */
  includeSupplementsForDbTemplate?: boolean;
  /** Allows a caller to tighten placeholder limits for a specific job. */
  variableLimits?: Partial<Record<string, number>>;
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

const PLAN_VARIABLE_LIMITS = {
  body: 12_000,
  plan_text: 10_000,
  previous_plan: 10_000,
};

const EXECUTION_VARIABLE_LIMITS = {
  body: 4_000,
  plan_text: 4_000,
  execution_contract: 3_000,
};

const FAILURE_VARIABLE_LIMITS = {
  failure_output: 6_000,
  ciLog: 6_000,
  ciSummary: 1_500,
  priorError: 4_000,
};

export const WORKER_PROMPTS: Record<WorkerPromptKey, WorkerPromptDefinition> = {
  "feature_plan": {
    dbKey: "feature_plan",
    filePath: `${WORKER_PROMPT_ROOT}/feature-plan.md`,
    supplements: ["planning-and-task-breakdown", "test-driven-development"],
    budget: {
      maxPromptChars: 18_000,
      maxSupplementChars: 2_000,
      variableLimits: { brief: 8_000, repository: 500 },
    },
  },
  "implementation_plan:create": {
    dbKey: "implementation_plan:create",
    filePath: `${WORKER_PROMPT_ROOT}/implementation-plan-create.md`,
    supplements: [
      "planning-and-task-breakdown",
      "test-driven-development",
      "incremental-implementation",
      "security-and-risk-gate",
    ],
    budget: {
      maxPromptChars: 24_000,
      maxSupplementChars: 3_000,
      variableLimits: { ...PLAN_VARIABLE_LIMITS, repository: 500, kind: 100, source: 100, title: 1_000 },
    },
  },
  "implementation_plan:improve": {
    dbKey: "implementation_plan:improve",
    filePath: `${WORKER_PROMPT_ROOT}/implementation-plan-improve.md`,
    supplements: ["planning-and-task-breakdown", "test-driven-development", "security-and-risk-gate"],
    budget: {
      maxPromptChars: 20_000,
      maxSupplementChars: 2_500,
      variableLimits: { ...PLAN_VARIABLE_LIMITS, title: 1_000 },
    },
  },
  "implementation_plan:contract_repair": {
    dbKey: "implementation_plan:contract_repair",
    filePath: `${WORKER_PROMPT_ROOT}/implementation-plan-contract-repair.md`,
    supplements: [],
    budget: {
      maxPromptChars: 14_000,
      maxSupplementChars: 0,
      variableLimits: { plan_text: 10_000 },
    },
  },
  "defect_scan:scan": {
    dbKey: "defect_scan:scan",
    filePath: `${WORKER_PROMPT_ROOT}/defect-scan.md`,
    supplements: ["code-review-and-quality", "debugging-and-error-recovery"],
    budget: {
      maxPromptChars: 14_000,
      maxSupplementChars: 2_000,
      variableLimits: { repository: 500, pr_changed_files: 3_000, typecheck_output: 4_000 },
    },
  },
  "defect_scan:plan": {
    dbKey: "defect_scan:plan",
    filePath: `${WORKER_PROMPT_ROOT}/defect-plan.md`,
    supplements: ["debugging-and-error-recovery", "test-driven-development"],
    budget: {
      maxPromptChars: 16_000,
      maxSupplementChars: 2_000,
      variableLimits: { repository: 500, title: 1_000, evidence: 3_000, impact: 500 },
    },
  },
  "defect_scan:triage": {
    dbKey: "defect_scan:triage",
    filePath: `${WORKER_PROMPT_ROOT}/defect-triage.md`,
    supplements: ["code-review-and-quality", "security-and-risk-gate"],
    budget: {
      maxPromptChars: 12_000,
      maxSupplementChars: 1_500,
      variableLimits: { repository: 500, findings: 7_000 },
    },
  },
  "refactor_scan:scan": {
    dbKey: "refactor_scan:scan",
    filePath: `${WORKER_PROMPT_ROOT}/refactor-scan.md`,
    supplements: ["code-review-and-quality", "incremental-implementation"],
    budget: {
      maxPromptChars: 12_000,
      maxSupplementChars: 1_500,
      variableLimits: { repository: 500 },
    },
  },
  "refactor_scan:plan": {
    dbKey: "refactor_scan:plan",
    filePath: `${WORKER_PROMPT_ROOT}/refactor-plan.md`,
    supplements: ["incremental-implementation", "test-driven-development"],
    budget: {
      maxPromptChars: 14_000,
      maxSupplementChars: 2_000,
      variableLimits: { repository: 500, title: 1_000, rationale: 4_000, files: 2_000 },
    },
  },
  "tdd_implementation:red_test": {
    dbKey: "tdd_implementation:red_test",
    filePath: `${WORKER_PROMPT_ROOT}/tdd-red-test.md`,
    supplements: ["test-driven-development"],
    budget: {
      maxPromptChars: 9_000,
      maxSupplementChars: 1_200,
      variableLimits: { ...EXECUTION_VARIABLE_LIMITS, title: 1_000, work_item_id: 100 },
    },
  },
  "tdd_implementation:green_implementation": {
    dbKey: "tdd_implementation:green_implementation",
    filePath: `${WORKER_PROMPT_ROOT}/tdd-green-implementation.md`,
    supplements: ["incremental-implementation", "security-and-risk-gate"],
    budget: {
      maxPromptChars: 9_000,
      maxSupplementChars: 1_500,
      variableLimits: { ...EXECUTION_VARIABLE_LIMITS, title: 1_000, work_item_id: 100 },
    },
  },
  "tdd_implementation:ci_fix": {
    dbKey: "tdd_implementation:ci_fix",
    filePath: `${WORKER_PROMPT_ROOT}/tdd-ci-fix.md`,
    supplements: ["debugging-and-error-recovery"],
    budget: {
      maxPromptChars: 12_000,
      maxSupplementChars: 1_200,
      variableLimits: { ...EXECUTION_VARIABLE_LIMITS, ...FAILURE_VARIABLE_LIMITS, title: 1_000 },
    },
  },
  "tdd_implementation:repair": {
    dbKey: "tdd_implementation:repair",
    filePath: `${WORKER_PROMPT_ROOT}/tdd-repair.md`,
    supplements: ["debugging-and-error-recovery", "security-and-risk-gate"],
    budget: {
      maxPromptChars: 12_000,
      maxSupplementChars: 1_500,
      variableLimits: { ...EXECUTION_VARIABLE_LIMITS, ...FAILURE_VARIABLE_LIMITS, title: 1_000 },
    },
  },
  "orchestrated_task:plan": {
    dbKey: "orchestrated_task:plan",
    filePath: `${WORKER_PROMPT_ROOT}/orchestrated-plan.md`,
    supplements: ["planning-and-task-breakdown", "security-and-risk-gate"],
    budget: {
      maxPromptChars: 18_000,
      maxSupplementChars: 2_000,
      variableLimits: { body: 10_000, title: 1_000, repository: 500 },
    },
  },
  "orchestrated_task:execute": {
    dbKey: "orchestrated_task:execute",
    filePath: `${WORKER_PROMPT_ROOT}/orchestrated-execute.md`,
    supplements: ["incremental-implementation", "security-and-risk-gate"],
    budget: {
      maxPromptChars: 12_000,
      maxSupplementChars: 1_500,
      variableLimits: { ...EXECUTION_VARIABLE_LIMITS, title: 1_000 },
    },
  },
};

export function truncateWorkerPromptValue(value: unknown, maxChars: number): string {
  const text = value == null ? "" : String(value);
  if (text.length <= maxChars) return text;

  const marker = `\n\n...[truncated ${text.length - maxChars} chars for worker prompt budget]...\n\n`;
  if (maxChars <= marker.length + 20) return text.slice(0, maxChars);

  const available = maxChars - marker.length;
  const headChars = Math.max(0, Math.floor(available * 0.35));
  const tailChars = Math.max(0, available - headChars);
  return `${text.slice(0, headChars)}${marker}${text.slice(text.length - tailChars)}`;
}

export function limitWorkerPromptVariables(
  key: WorkerPromptKey,
  variables: Record<string, unknown>,
  overrides: Partial<Record<string, number>> = {},
): Record<string, string> {
  const limits = { ...WORKER_PROMPTS[key].budget.variableLimits, ...overrides };
  return Object.fromEntries(
    Object.entries(variables).map(([name, value]) => {
      const limit = limits[name];
      return [name, typeof limit === "number" ? truncateWorkerPromptValue(value, limit) : value == null ? "" : String(value)];
    }),
  );
}

export function renderWorkerPrompt(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\$?\{([A-Za-z0-9_]+)\}/g, (match, key: string) => {
    if (!(key in variables)) return match;
    const value = variables[key];
    return value == null ? "" : String(value);
  });
}

export function limitWorkerPromptSupplements(supplementTexts: string[], maxChars: number): string[] {
  const result: string[] = [];
  let remaining = maxChars;

  for (const text of supplementTexts.map(value => value.trim()).filter(Boolean)) {
    if (remaining <= 0) break;
    const limited = truncateWorkerPromptValue(text, remaining);
    result.push(limited);
    remaining -= limited.length;
  }

  return result;
}

export function appendWorkerPromptSupplements(
  basePrompt: string,
  supplementTexts: string[],
  maxSupplementChars = Number.POSITIVE_INFINITY,
): string {
  const nonEmpty = limitWorkerPromptSupplements(supplementTexts, maxSupplementChars);
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

export function estimateWorkerPromptChars(prompt: string): number {
  return prompt.length;
}

export async function loadWorkerPrompt(
  key: WorkerPromptKey,
  variables: Record<string, unknown>,
  reader: WorkerPromptReader,
  options: LoadWorkerPromptOptions = {},
): Promise<string> {
  const definition = WORKER_PROMPTS[key];
  const usingDbTemplate = Boolean(options.dbTemplate?.trim());
  const baseTemplate = usingDbTemplate
    ? String(options.dbTemplate)
    : await reader.readText(definition.filePath);

  const limitedVariables = limitWorkerPromptVariables(key, variables, options.variableLimits);
  const renderedBase = renderWorkerPrompt(baseTemplate, limitedVariables);

  const shouldAppendSupplements = options.includeSupplements !== false &&
    (!usingDbTemplate || options.includeSupplementsForDbTemplate === true);

  if (!shouldAppendSupplements) {
    return renderedBase.trim();
  }

  const supplementTexts = await Promise.all(
    definition.supplements.map(supplement => reader.readText(WORKER_PROMPT_SUPPLEMENT_FILES[supplement])),
  );

  return appendWorkerPromptSupplements(renderedBase, supplementTexts, definition.budget.maxSupplementChars);
}
