import { describe, expect, it } from "vitest";
import { validateGeneratedImplementationPlan } from "../src/implementationPlanQuality.js";

const BASE_PLAN = `
## Problem Summary
A bounded feature change.

## Target Files
\`\`\`json
[
  {
    "path": "src/example.ts",
    "classification": "existing_at_base",
    "owner": "example module",
    "dependency_ref": null,
    "rationale": "change the current production owner"
  },
  {
    "path": "test/example.test.ts",
    "classification": "proposed_new_test",
    "owner": "example module tests",
    "dependency_ref": null,
    "rationale": "add production-boundary regression coverage"
  }
]
\`\`\`

## Architectural Intent
Preserve the production handler and repository ownership boundary.

## Test Plan
Run the production-boundary test first.

## Implementation Phases
1. Red test.
2. Green implementation.

## Acceptance Criteria
- AC-1: the user-visible behaviour is correct.

## Verification Commands
npm test -- test/example.test.ts
`;

const COMPLETE_RED_TESTS = `
## Red Tests
[
  {
    "id": "RT-1",
    "requirement_ids": ["AC-1"],
    "intent": {
      "product": ["user-visible behaviour"],
      "architecture": ["production handler ownership"],
      "invariants": ["sibling behaviour remains unchanged"],
      "risks": ["compatibility"]
    },
    "test_classes": ["behavioural", "architecture", "compatibility"],
    "characterization_required": false,
    "test_file": "test/example.test.ts",
    "test_name": "uses the production handler",
    "production_boundary": "real handler entry point",
    "fixture_and_state": "current persisted state",
    "action_through_real_caller": "invoke the handler through the registered job path",
    "expected_observable_result": "authoritative persisted result",
    "why_current_code_fails": "the production handler is not wired",
    "expected_red_assertion": "expected result is absent",
    "focused_red_command": "npm test -- test/example.test.ts",
    "sibling_behaviour_remaining_green": ["existing sibling job remains green"],
    "authoritative_oracle": "persisted repository state",
    "false_positive_controls": ["baseline passes before the new assertion"]
  }
]

## Red Test Coverage
{
  "acceptance_coverage": [{"requirement_id":"AC-1", "red_test_ids":["RT-1"]}],
  "architecture_coverage": [{"boundary_or_invariant":"production handler ownership", "red_test_ids":["RT-1"]}],
  "triggered_risk_coverage": [{"risk":"compatibility", "required_test_classes":["compatibility"], "red_test_ids":["RT-1"]}]
}
`;

describe("implementation plan red-test quality", () => {
  it("rejects a plan that omits the red-test contract", () => {
    const result = validateGeneratedImplementationPlan(BASE_PLAN);

    expect(result.valid).toBe(false);
    expect(result.missing).toContain("Red Tests");
    expect(result.missing).toContain("Red Test Coverage");
  });

  it("rejects generic test wording without production-boundary intent", () => {
    const result = validateGeneratedImplementationPlan(`${BASE_PLAN}\n## Red Tests\nWrite unit tests.\n\n## Red Test Coverage\nAdd coverage.`);

    expect(result.valid).toBe(false);
    expect(result.missing).toContain("Comprehensive red-test fields");
    expect(result.missing).toContain("Red-test coverage matrices");
  });

  it("rejects target paths without structured provenance", () => {
    const result = validateGeneratedImplementationPlan(`${BASE_PLAN.replace(
      /## Target Files[\s\S]*?## Architectural Intent/,
      "## Target Files\n- src/example.ts\n- test/example.test.ts\n\n## Architectural Intent",
    )}\n${COMPLETE_RED_TESTS}`);

    expect(result.valid).toBe(false);
    expect(result.missing).toContain("Target-file classification");
  });

  it("rejects invalid or unclassified target paths", () => {
    const result = validateGeneratedImplementationPlan(`${BASE_PLAN.replace(
      '"classification": "existing_at_base"',
      '"classification": "invalid_or_unclassified"',
    )}\n${COMPLETE_RED_TESTS}`);

    expect(result.valid).toBe(false);
    expect(result.missing).toContain("Target-file classification");
  });

  it("requires an exact dependency reference for dependency-owned paths", () => {
    const result = validateGeneratedImplementationPlan(`${BASE_PLAN.replace(
      '"classification": "existing_at_base"',
      '"classification": "existing_in_dependency"',
    )}\n${COMPLETE_RED_TESTS}`);

    expect(result.valid).toBe(false);
    expect(result.missing).toContain("Target-file classification");
  });

  it("accepts a plan containing classified targets and comprehensive red-test coverage", () => {
    const result = validateGeneratedImplementationPlan(`${BASE_PLAN}\n${COMPLETE_RED_TESTS}`);

    expect(result).toEqual({ valid: true, missing: [] });
  });

  it("rejects red-test sections that only mention the required field names", () => {
    const result = validateGeneratedImplementationPlan(`${BASE_PLAN}
## Red Tests
requirement_ids product architecture invariants risks test_classes test_file test_name production_boundary fixture_and_state action_through_real_caller expected_observable_result why_current_code_fails expected_red_assertion focused_red_command sibling_behaviour_remaining_green authoritative_oracle false_positive_controls

## Red Test Coverage
acceptance_coverage architecture_coverage triggered_risk_coverage`);

    expect(result.valid).toBe(false);
    expect(result.missing).toContain("Structured red-test records");
    expect(result.missing).toContain("Structured red-test coverage");
  });

  it("rejects coverage that references unknown red tests or omits required mappings", () => {
    const malformed = COMPLETE_RED_TESTS
      .replace('"red_test_ids":["RT-1"]', '"red_test_ids":["RT-404"]')
      .replace('"red_test_ids":["RT-1"]', '"red_test_ids":[]');
    const result = validateGeneratedImplementationPlan(`${BASE_PLAN}\n${malformed}`);

    expect(result.valid).toBe(false);
    expect(result.missing).toContain("Red-test coverage references");
  });

  it.each(["\"RT-1\"", "null", "{}"])(
    "rejects scalar/object/null acceptance red_test_ids: %s",
    redTestIds => {
      const malformed = COMPLETE_RED_TESTS.replace(
        '"red_test_ids":["RT-1"]',
        `"red_test_ids":${redTestIds},"non_test_proof":"claimed proof"`,
      );
      const result = validateGeneratedImplementationPlan(`${BASE_PLAN}\n${malformed}`);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain("Structured red-test coverage");
    },
  );
});
