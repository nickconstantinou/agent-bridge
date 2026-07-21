/**
 * PURPOSE: Validate implementation plans before generation persistence or later work-item approval.
 * NEIGHBORS: src/handlers/implementationPlan.ts, src/workCallbacks.ts, src/approvalHtml.ts
 */

export interface PlanValidationResult {
  valid: boolean;
  missing: string[];
}

export interface PlanValidationOptions {
  /** Pre-provenance stored plans may retain concrete bullet paths; newly generated plans must set false. */
  allowLegacyTargetFiles?: boolean;
}

const REQUIRED_SECTIONS = [
  "Problem Summary",
  "Target Files",
  "Architectural Intent",
  "Test Plan",
  "Red Tests",
  "Red Test Coverage",
  "Implementation Phases",
  "Acceptance Criteria",
  "Verification Commands",
];

const RED_TEST_FIELDS = [
  "requirement_ids",
  "product",
  "architecture",
  "invariants",
  "risks",
  "test_classes",
  "test_file",
  "test_name",
  "production_boundary",
  "fixture_and_state",
  "action_through_real_caller",
  "expected_observable_result",
  "why_current_code_fails",
  "expected_red_assertion",
  "focused_red_command",
  "sibling_behaviour_remaining_green",
  "authoritative_oracle",
  "false_positive_controls",
];

const RED_TEST_COVERAGE_FIELDS = [
  "acceptance_coverage",
  "architecture_coverage",
  "triggered_risk_coverage",
];

const TARGET_FILE_CLASSIFICATIONS = new Set([
  "existing_at_base",
  "existing_in_dependency",
  "proposed_new_production",
  "proposed_new_test",
]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSection(text: string, section: string): string {
  const heading = new RegExp(`^#{1,3}\\s+${escapeRegex(section)}\\s*$`, "im");
  const match = heading.exec(text);
  if (!match) return "";

  const bodyStart = match.index + match[0].length;
  const remaining = text.slice(bodyStart);
  const nextHeading = /^#{1,3}\s+.+$/m.exec(remaining);
  return (nextHeading ? remaining.slice(0, nextHeading.index) : remaining).trim();
}

function containsAllFields(sectionText: string, fields: readonly string[]): boolean {
  return fields.every(field => new RegExp(`\\b${escapeRegex(field)}\\b`, "i").test(sectionText));
}

function extractJsonValue(sectionText: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(sectionText);
  const raw = (fenced?.[1] ?? sectionText).trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasStructuredTargetFileClassification(sectionText: string): boolean {
  const parsed = extractJsonValue(sectionText);
  if (!Array.isArray(parsed) || parsed.length === 0) return false;

  return parsed.every(entry => {
    if (typeof entry !== "object" || entry === null) return false;
    const record = entry as Record<string, unknown>;
    if (!isNonEmptyString(record.path)) return false;
    if (!isNonEmptyString(record.classification)) return false;
    if (!TARGET_FILE_CLASSIFICATIONS.has(record.classification)) return false;
    if (!isNonEmptyString(record.owner)) return false;
    if (!isNonEmptyString(record.rationale)) return false;
    if (record.classification === "existing_in_dependency" && !isNonEmptyString(record.dependency_ref)) {
      return false;
    }
    return record.dependency_ref === null
      || record.dependency_ref === undefined
      || isNonEmptyString(record.dependency_ref);
  });
}

const RED_TEST_INTENT_FIELDS = ["product", "architecture", "invariants", "risks"] as const;
const RED_TEST_STRING_FIELDS = [
  "id",
  "test_file",
  "test_name",
  "production_boundary",
  "fixture_and_state",
  "action_through_real_caller",
  "expected_observable_result",
  "why_current_code_fails",
  "expected_red_assertion",
  "focused_red_command",
  "authoritative_oracle",
] as const;
const RED_TEST_ARRAY_FIELDS = [
  "requirement_ids",
  "test_classes",
  "sibling_behaviour_remaining_green",
  "false_positive_controls",
] as const;

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every(item => isNonEmptyString(item));
}

function hasStructuredRedTests(sectionText: string): { valid: boolean; ids: Set<string> } {
  const parsed = extractJsonValue(sectionText);
  if (!Array.isArray(parsed) || parsed.length === 0) return { valid: false, ids: new Set() };

  const ids = new Set<string>();
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { valid: false, ids: new Set() };
    }
    const record = entry as Record<string, unknown>;
    for (const field of RED_TEST_STRING_FIELDS) {
      if (!isNonEmptyString(record[field])) return { valid: false, ids: new Set() };
    }
    if (ids.has(record.id as string)) return { valid: false, ids: new Set() };
    ids.add(record.id as string);
    for (const field of RED_TEST_ARRAY_FIELDS) {
      if (!isNonEmptyStringArray(record[field])) return { valid: false, ids: new Set() };
    }
    if (typeof record.characterization_required !== "boolean") {
      return { valid: false, ids: new Set() };
    }
    if (typeof record.intent !== "object" || record.intent === null || Array.isArray(record.intent)) {
      return { valid: false, ids: new Set() };
    }
    const intent = record.intent as Record<string, unknown>;
    for (const field of RED_TEST_INTENT_FIELDS) {
      if (!isNonEmptyStringArray(intent[field])) return { valid: false, ids: new Set() };
    }
  }
  return { valid: true, ids };
}

function hasStructuredRedTestCoverage(sectionText: string, redTestIds: Set<string>): {
  valid: boolean;
  referencesValid: boolean;
} {
  const parsed = extractJsonValue(sectionText);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { valid: false, referencesValid: false };
  }
  const coverage = parsed as Record<string, unknown>;
  const acceptance = coverage.acceptance_coverage;
  const architecture = coverage.architecture_coverage;
  const risks = coverage.triggered_risk_coverage;
  if (!Array.isArray(acceptance) || acceptance.length === 0
    || !Array.isArray(architecture) || architecture.length === 0
    || !Array.isArray(risks) || risks.length === 0) {
    return { valid: false, referencesValid: false };
  }

  const references = (value: unknown): string[] | null => {
    if (!Array.isArray(value) || value.length === 0 || !value.every(item => isNonEmptyString(item))) return null;
    return value as string[];
  };
  const optionalReferences = (value: unknown): string[] | null => {
    if (!Array.isArray(value) || !value.every(item => isNonEmptyString(item))) return null;
    return value as string[];
  };
  const referencesKnown = (ids: string[] | null): boolean => ids !== null && ids.every(id => redTestIds.has(id));

  for (const entry of acceptance) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return { valid: false, referencesValid: false };
    const record = entry as Record<string, unknown>;
    if (!isNonEmptyString(record.requirement_id)) return { valid: false, referencesValid: false };
    if (!Array.isArray(record.red_test_ids)
      || !record.red_test_ids.every(item => isNonEmptyString(item))) {
      return { valid: false, referencesValid: false };
    }
    const redIds = record.red_test_ids as string[];
    const proof = record.non_test_proof;
    if (redIds.length === 0) {
      if (!isNonEmptyString(proof)) return { valid: false, referencesValid: false };
    } else if (!referencesKnown(redIds)) {
      return { valid: true, referencesValid: false };
    }
  }
  for (const entry of architecture) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return { valid: false, referencesValid: false };
    const record = entry as Record<string, unknown>;
    if (!isNonEmptyString(record.boundary_or_invariant)) return { valid: false, referencesValid: false };
    const redIds = references(record.red_test_ids);
    const characterizationIds = record.characterization_test_ids === undefined
      ? []
      : optionalReferences(record.characterization_test_ids);
    if (!referencesKnown(redIds) || characterizationIds === null && record.characterization_test_ids !== undefined
      || !referencesKnown(characterizationIds ?? [])) return { valid: false, referencesValid: false };
  }
  for (const entry of risks) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return { valid: false, referencesValid: false };
    const record = entry as Record<string, unknown>;
    const redIds = references(record.red_test_ids);
    if (!isNonEmptyString(record.risk) || !isNonEmptyStringArray(record.required_test_classes)
      || !referencesKnown(redIds)) return { valid: false, referencesValid: false };
  }
  return { valid: true, referencesValid: true };
}

function hasLegacyConcreteTargetFiles(sectionText: string): boolean {
  if (/invalid_or_unclassified/i.test(sectionText)) return false;
  const paths = sectionText.match(/\b(?:src|test|scripts|docs)\/[^\s`),]+/gi) ?? [];
  return paths.length > 0;
}

export function validateImplementationPlan(
  planText: string | null | undefined,
  options: PlanValidationOptions = { allowLegacyTargetFiles: true },
): PlanValidationResult {
  const text = planText?.trim() ?? "";
  const missing: string[] = [];
  for (const section of REQUIRED_SECTIONS) {
    const pattern = new RegExp(`^#{1,3}\\s+${escapeRegex(section)}\\s*$`, "im");
    if (!pattern.test(text)) missing.push(section);
  }

  const targetFiles = extractSection(text, "Target Files");
  const targetFilesValid = hasStructuredTargetFileClassification(targetFiles)
    || (options.allowLegacyTargetFiles === true && hasLegacyConcreteTargetFiles(targetFiles));
  if (!targetFilesValid) missing.push("Target-file classification");

  const redTests = extractSection(text, "Red Tests");
  const structuredRedTests = hasStructuredRedTests(redTests);
  if (!structuredRedTests.valid || !containsAllFields(redTests, RED_TEST_FIELDS)) {
    missing.push("Comprehensive red-test fields");
    missing.push("Structured red-test records");
  }

  const redTestCoverage = extractSection(text, "Red Test Coverage");
  const structuredCoverage = hasStructuredRedTestCoverage(redTestCoverage, structuredRedTests.ids);
  if (!structuredCoverage.valid || !containsAllFields(redTestCoverage, RED_TEST_COVERAGE_FIELDS)) {
    missing.push("Red-test coverage matrices");
    missing.push("Structured red-test coverage");
  } else if (!structuredCoverage.referencesValid) {
    missing.push("Red-test coverage references");
  }

  if (!/\b(?:src|test|scripts|docs)\/[^\s`),]+/i.test(text)) missing.push("Concrete file paths");
  if (!/\b(?:npm|pnpm|yarn|vitest|pytest|tsc|cargo|go test)\b/i.test(text)) missing.push("Verification command");
  return { valid: missing.length === 0, missing };
}

/** New or repaired model output must always carry reproducible target-path provenance. */
export function validateGeneratedImplementationPlan(
  planText: string | null | undefined,
): PlanValidationResult {
  return validateImplementationPlan(planText, { allowLegacyTargetFiles: false });
}
