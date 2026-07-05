import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function src(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("scan and planning prompt wiring", () => {
  it("feature planning uses the prompt pack", () => {
    const text = src("src/handlers/featurePlan.ts");

    expect(text).toContain("loadWorkerPrompt");
    expect(text).toContain("feature_plan");
  });

  it("defect scan uses prompt-pack keys for scan, plan, and triage", () => {
    const text = src("src/handlers/defectScan.ts");

    expect(text).toContain("loadWorkerPrompt");
    expect(text).toContain("defect_scan:scan");
    expect(text).toContain("defect_scan:plan");
    expect(text).toContain("defect_scan:triage");
  });

  it("refactor scan uses prompt-pack keys for scan and plan", () => {
    const text = src("src/handlers/refactorScan.ts");

    expect(text).toContain("loadWorkerPrompt");
    expect(text).toContain("refactor_scan:scan");
    expect(text).toContain("refactor_scan:plan");
  });

  it("orchestrated tasks are either wired or explicitly retired", () => {
    const text = src("src/handlers/orchestratedTask.ts");

    expect(text).toMatch(/orchestrated_task:plan|deprecated|retired/);
    expect(text).toMatch(/orchestrated_task:execute|deprecated|retired/);
  });
});
