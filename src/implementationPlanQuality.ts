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
  if (!containsAllFields(redTests, RED_TEST_FIELDS)) {
    missing.push("Comprehensive red-test fields");
  }

  const redTestCoverage = extractSection(text, "Red Test Coverage");
  if (!containsAllFields(redTestCoverage, RED_TEST_COVERAGE_FIELDS)) {
    missing.push("Red-test coverage matrices");
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
