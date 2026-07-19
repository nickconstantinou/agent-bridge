/**
 * PURPOSE: Validate implementation plans before work item approval.
 * NEIGHBORS: src/handlers/implementationPlan.ts, src/workCallbacks.ts, src/approvalHtml.ts
 */

export interface PlanValidationResult {
  valid: boolean;
  missing: string[];
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

export function validateImplementationPlan(planText: string | null | undefined): PlanValidationResult {
  const text = planText?.trim() ?? "";
  const missing: string[] = [];
  for (const section of REQUIRED_SECTIONS) {
    const pattern = new RegExp(`^#{1,3}\\s+${escapeRegex(section)}\\s*$`, "im");
    if (!pattern.test(text)) missing.push(section);
  }

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
