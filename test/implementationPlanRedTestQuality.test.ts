import { describe, expect, it } from "vitest";
import { validateImplementationPlan } from "../src/implementationPlanQuality.js";

const BASE_PLAN = `
## Problem Summary
A bounded feature change.

## Target Files
- src/example.ts
- test/example.test.ts

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
    const result = validateImplementationPlan(BASE_PLAN);

    expect(result.valid).toBe(false);
    expect(result.missing).toContain("Red Tests");
    expect(result.missing).toContain("Red Test Coverage");
  });

  it("rejects generic test wording without production-boundary intent", () => {
    const result = validateImplementationPlan(`${BASE_PLAN}\n## Red Tests\nWrite unit tests.\n\n## Red Test Coverage\nAdd coverage.`);

    expect(result.valid).toBe(false);
    expect(result.missing).toContain("Comprehensive red-test fields");
    expect(result.missing).toContain("Red-test coverage matrices");
  });

  it("accepts a plan containing the comprehensive red-test and coverage contracts", () => {
    const result = validateImplementationPlan(`${BASE_PLAN}\n${COMPLETE_RED_TESTS}`);

    expect(result).toEqual({ valid: true, missing: [] });
  });
});
