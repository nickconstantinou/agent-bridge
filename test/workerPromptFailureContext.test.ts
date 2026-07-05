import { describe, expect, it } from "vitest";
import { buildExecutionPromptContext } from "../src/workerPromptContracts.js";

const contract = {
  target_files: ["src/handlers/tddImplementation.ts"],
  test_files: ["test/workerPromptFailureContext.test.ts"],
  phase_order: ["red-test", "green-implementation", "verification"],
  red_test_command: "npm test -- workerPromptFailureContext",
  verification_command: "npm test -- workerPromptFailureContext && npm run typecheck",
  risk_level: "medium",
  human_decision_required: false,
  out_of_scope: ["unrelated cleanup"],
  notes_for_red_pass: "Add only the required test coverage.",
  notes_for_green_pass: "Keep the production change narrow.",
};

describe("worker prompt failure context", () => {
  it("keeps CI context focused and bounded", () => {
    const context = buildExecutionPromptContext({
      planText: "## Execution Contract\ncompact plan",
      executionContract: contract,
      phase: "ci_fix",
      failureOutput: `npm test output\n${"noise\n".repeat(1000)}\nTypeError: missing worker prompt contract`,
    });

    expect(context.execution_contract).toContain("tddImplementation.ts");
    expect(context.failure_output).toContain("TypeError");
    expect(context.failure_output.length).toBeLessThan(7000);
  });
});
