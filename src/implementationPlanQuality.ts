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
  "Implementation Phases",
  "Acceptance Criteria",
  "Verification Commands",
];

export function validateImplementationPlan(planText: string | null | undefined): PlanValidationResult {
  const text = planText?.trim() ?? "";
  const missing: string[] = [];
  for (const section of REQUIRED_SECTIONS) {
    const pattern = new RegExp(`^#{1,3}\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im");
    if (!pattern.test(text)) missing.push(section);
  }
  if (!/\b(?:src|test|scripts|docs)\/[^\s`),]+/i.test(text)) missing.push("Concrete file paths");
  if (!/\b(?:npm|pnpm|yarn|vitest|pytest|tsc|cargo|go test)\b/i.test(text)) missing.push("Verification command");
  return { valid: missing.length === 0, missing };
}
