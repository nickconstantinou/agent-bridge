import { describe, expect, it } from "vitest";
import {
  buildExecutionPromptContext,
  extractExecutionContract,
} from "../src/workerPromptContracts.js";

const completePlan = `
## Problem Summary
Implement prompt-pack wiring.

## Execution Contract

\`\`\`json
{
  "target_files": ["src/handlers/implementationPlan.ts", "src/handlers/tddImplementation.ts"],
  "test_files": ["test/workerPromptContracts.test.ts"],
  "phase_order": ["red-test", "green-implementation", "verification"],
  "red_test_command": "npm test -- workerPromptContracts",
  "verification_command": "npm test -- workerPromptContracts && npm run typecheck",
  "risk_level": "medium",
  "human_decision_required": false,
  "out_of_scope": ["schema migration", "merge-gate changes"],
  "notes_for_red_pass": "Use the contract and write tests only.",
  "notes_for_green_pass": "Wire prompts without changing worker safety gates."
}
\`\`\`

## Acceptance Criteria
- The contract is extracted.
`;

describe("worker prompt execution contract", () => {
  it("extracts a valid execution contract from the implementation plan", () => {
    const result = extractExecutionContract(completePlan);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    expect(result.contract.target_files).toEqual([
      "src/handlers/implementationPlan.ts",
      "src/handlers/tddImplementation.ts",
    ]);
    expect(result.contract.test_files).toEqual(["test/workerPromptContracts.test.ts"]);
    expect(result.contract.red_test_command).toBe("npm test -- workerPromptContracts");
    expect(result.contract.verification_command).toContain("npm run typecheck");
    expect(result.contract.risk_level).toBe("medium");
    expect(result.contract.out_of_scope).toContain("merge-gate changes");
  });

  it("fails safe when the execution contract is missing", () => {
    const result = extractExecutionContract("## Problem Summary\nNo contract here.");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected missing contract to fail");
    expect(result.error).toMatch(/execution contract/i);
  });

  it("fails safe when the execution contract JSON is invalid", () => {
    const result = extractExecutionContract(`
## Execution Contract

\`\`\`json
{ "target_files": ["src/a.ts"],
\`\`\`
`);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid JSON to fail");
    expect(result.error).toMatch(/json/i);
  });

  it("builds compact red and green prompt context from the contract", () => {
    const extracted = extractExecutionContract(completePlan);
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) throw new Error(extracted.error);

    const context = buildExecutionPromptContext({
      planText: `${completePlan}\n## Long unrelated appendix\n${"extra context ".repeat(2000)}`,
      executionContract: extracted.contract,
      phase: "green",
    });

    expect(JSON.parse(context.execution_contract)).toMatchObject({
      verification_command: "npm test -- workerPromptContracts && npm run typecheck",
    });
    expect(context.plan_text).toContain("notes_for_green_pass");
    expect(context.plan_text).not.toContain("Long unrelated appendix");
    expect(context.plan_text.length).toBeLessThan(2500);
  });
});
