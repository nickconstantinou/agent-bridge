import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function src(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("implementation plan wiring", () => {
  it("records execution contract metadata", () => {
    const text = src("src/handlers/implementationPlan.ts");

    expect(text).toContain("extractExecutionContract");
    expect(text).toContain("execution_contract");
  });

  it("uses improve prompt when contract metadata is not usable", () => {
    const text = src("src/handlers/implementationPlan.ts");

    expect(text).toContain("implementation_plan:improve");
    expect(text).toContain("extractExecutionContract");
  });
});
