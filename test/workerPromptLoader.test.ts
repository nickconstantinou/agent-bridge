import { describe, expect, it } from "vitest";
import {
  loadWorkerPrompt,
  renderWorkerPrompt,
  truncateWorkerPromptValue,
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

  it("uses an override without extras by default", async () => {
    const prompt = await loadWorkerPrompt("feature_plan", { value: "abc" }, reader, {
      dbTemplate: "Override {value}",
    });

    expect(prompt).toBe("Override abc");
  });

  it("can append extras to an override when requested", async () => {
    const prompt = await loadWorkerPrompt("feature_plan", { value: "abc" }, reader, {
      dbTemplate: "Override {value}",
      includeSupplementsForDbTemplate: true,
    });

    expect(prompt).toContain("Override abc");
    expect(prompt).toContain("Supplement text");
  });

  it("caps long values with a visible marker", () => {
    const capped = truncateWorkerPromptValue("0123456789".repeat(40), 120);

    expect(capped.length).toBeLessThanOrEqual(120);
    expect(capped).toContain("truncated");
  });
});
