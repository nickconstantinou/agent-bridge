import { describe, expect, it } from "vitest";
import {
  loadWorkerPrompt,
  renderWorkerPrompt,
  truncateWorkerPromptValue,
} from "../src/workerPrompts.js";

const reader = {
  readText(path: string): string {
    if (path.endsWith("feature-plan.md")) return "Feature {value}";
    const skillMatch = path.match(/^skills\/([^/]+)\/(SKILL\.md|skill\.json)$/);
    if (skillMatch) {
      const [, name, file] = skillMatch;
      if (file === "skill.json") {
        return JSON.stringify({ name, version: "1.0.0", description: `${name} test skill` });
      }
      return [
        `# ${name}`,
        "<!-- BEGIN AGENT_BRIDGE_RUNTIME_GUIDANCE -->",
        `Canonical guidance from ${name}`,
        "<!-- END AGENT_BRIDGE_RUNTIME_GUIDANCE -->",
      ].join("\n");
    }
    return "Supplement text";
  },
};

describe("worker loader basics", () => {
  it("renders placeholders", () => {
    expect(renderWorkerPrompt("Hello {name}", { name: "Nick" })).toBe("Hello Nick");
  });

  it("keeps canonical lifecycle skills when optional worker supplements are disabled", async () => {
    const prompt = await loadWorkerPrompt("feature_plan", { value: "abc" }, reader, {
      includeSupplements: false,
    });

    expect(prompt).toContain("Feature abc");
    expect(prompt).toContain("Lifecycle skill: requirements-to-acceptance@1.0.0");
    expect(prompt).toContain("Canonical guidance from risk-based-test-strategy");
    expect(prompt).toContain("Canonical guidance from red-green-refactor-tdd");
    expect(prompt).not.toContain("# Worker-specific supplements");
    expect(prompt).not.toContain("Supplement text");
  });

  it("appends canonical lifecycle skills and registered worker supplements", async () => {
    const prompt = await loadWorkerPrompt("feature_plan", { value: "abc" }, reader);

    expect(prompt).toContain("Feature abc");
    expect(prompt).toContain("Lifecycle skill: requirements-to-acceptance@1.0.0");
    expect(prompt).toContain("Canonical guidance from risk-based-test-strategy");
    expect(prompt).toContain("Canonical guidance from red-green-refactor-tdd");
    expect(prompt).toContain("# Worker-specific supplements");
    expect(prompt).toContain("Supplement text");
  });

  it("caps long values with a visible marker", () => {
    const capped = truncateWorkerPromptValue("0123456789".repeat(40), 120);

    expect(capped.length).toBeLessThanOrEqual(120);
    expect(capped).toContain("truncated");
  });
});
