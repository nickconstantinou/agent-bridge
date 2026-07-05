import { describe, expect, it } from "vitest";
import {
  loadWorkerPrompt,
  renderWorkerPrompt,
} from "../src/workerPrompts.js";

const reader = {
  readText(path: string): string {
    if (path.endsWith("feature-plan.md")) return "Feature {value}";
    return "Supplement text";
  },
};

describe("worker loader basics", () => {
  it("renders placeholders", () => {
    expect(renderWorkerPrompt("Hello {name}", { name: "Nick" })).toBe("Hello Nick");
  });

  it("loads a bundled template", async () => {
    const prompt = await loadWorkerPrompt("feature_plan", { value: "abc" }, reader, {
      includeSupplements: false,
    });

    expect(prompt).toBe("Feature abc");
  });
});
