import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readRepoFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("worker prompt-pack wiring", () => {
  it("implementationPlan handler uses prompt-pack dependencies", () => {
    const source = readRepoFile("src/handlers/implementationPlan.ts");

    expect(source).toContain("workerPrompts");
    expect(source).toContain("workerPromptContracts");
    expect(source).toContain("loadWorkerPrompt");
    expect(source).toContain("implementation_plan:create");
    expect(source).toContain("implementation_plan:improve");
    expect(source).toContain("extractExecutionContract");
  });

  it("tddImplementation handler uses compact execution context", () => {
    const source = readRepoFile("src/handlers/tddImplementation.ts");

    expect(source).toContain("workerPrompts");
    expect(source).toContain("workerPromptContracts");
    expect(source).toContain("loadWorkerPrompt");
    expect(source).toContain("buildExecutionPromptContext");
    expect(source).toContain("tdd_implementation:red_test");
    expect(source).toContain("tdd_implementation:green_implementation");
    expect(source).toContain("tdd_implementation:ci_fix");
    expect(source).toContain("tdd_implementation:repair");
  });

  it("execution prompts use contract-shaped variables", () => {
    const source = readRepoFile("src/handlers/tddImplementation.ts");

    expect(source).toContain("execution_contract");
    expect(source).toContain("plan_text");
  });
});
