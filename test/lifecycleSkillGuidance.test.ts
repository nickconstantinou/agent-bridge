import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENTIC_PROMPT_CONTRACTS,
  AGENTIC_PROMPT_LIFECYCLE_SKILLS,
  loadAgenticPrompt,
  type AgenticPromptKey,
} from "../src/agenticPromptContracts.js";
import {
  LIFECYCLE_SKILLS,
  RUNTIME_GUIDANCE_END,
  RUNTIME_GUIDANCE_START,
  loadLifecycleSkillGuidance,
  type LifecycleSkillKey,
  type LifecycleSkillReader,
} from "../src/lifecycleSkillGuidance.js";

const branchReader: LifecycleSkillReader = {
  readText: async (path: string) => readFileSync(resolve(process.cwd(), path), "utf8"),
};

function variablesFor(key: AgenticPromptKey): Record<string, string> {
  return Object.fromEntries(
    AGENTIC_PROMPT_CONTRACTS[key].requiredVariables.map(name => [name, `${name} evidence`]),
  );
}

function overridingReader(overrides: Record<string, (current: string) => string>): LifecycleSkillReader {
  return {
    async readText(path: string): Promise<string> {
      const current = readFileSync(resolve(process.cwd(), path), "utf8");
      return overrides[path]?.(current) ?? current;
    },
  };
}

const ALL_SKILLS = Object.keys(LIFECYCLE_SKILLS) as LifecycleSkillKey[];

describe("canonical lifecycle skill guidance", () => {
  it("loads one versioned runtime block from every canonical SDLC skill", async () => {
    const loaded = await loadLifecycleSkillGuidance(ALL_SKILLS, branchReader);

    expect(loaded.map(skill => skill.key)).toEqual(ALL_SKILLS);
    for (const skill of loaded) {
      expect(skill.version).toBe("1.0.0");
      expect(skill.content.length, skill.key).toBeGreaterThan(120);
      expect(skill.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(skill.content).not.toContain(RUNTIME_GUIDANCE_START);
      expect(skill.content).not.toContain(RUNTIME_GUIDANCE_END);
    }
  });

  it("binds lifecycle know-how explicitly to every role and mode", () => {
    for (const [key, contract] of Object.entries(AGENTIC_PROMPT_CONTRACTS) as Array<[
      AgenticPromptKey,
      (typeof AGENTIC_PROMPT_CONTRACTS)[AgenticPromptKey],
    ]>) {
      expect(contract.lifecycleSkills).toEqual(AGENTIC_PROMPT_LIFECYCLE_SKILLS[key]);
      expect(new Set(contract.lifecycleSkills).size).toBe(contract.lifecycleSkills.length);
    }

    expect(AGENTIC_PROMPT_LIFECYCLE_SKILLS["technical_lead:planning"]).toEqual([
      "requirements-to-acceptance",
      "risk-based-test-strategy",
      "red-green-refactor-tdd",
    ]);
    expect(AGENTIC_PROMPT_LIFECYCLE_SKILLS["code_worker:red"]).toEqual([
      "risk-based-test-strategy",
      "red-green-refactor-tdd",
    ]);
    expect(AGENTIC_PROMPT_LIFECYCLE_SKILLS["technical_lead:pr_readiness"]).toEqual([
      "risk-based-test-strategy",
      "release-readiness-review",
    ]);
  });

  it("composes only the declared skills and records their exact identities", async () => {
    for (const key of Object.keys(AGENTIC_PROMPT_CONTRACTS) as AgenticPromptKey[]) {
      const loaded = await loadAgenticPrompt(key, variablesFor(key), branchReader);
      const expected = AGENTIC_PROMPT_LIFECYCLE_SKILLS[key];

      expect(loaded.lifecycleSkills.map(skill => skill.key), key).toEqual(expected);
      expect(loaded.lifecycleSkillSetHash).toMatch(/^[a-f0-9]{64}$/);
      expect(loaded.composedContentHash).toMatch(/^[a-f0-9]{64}$/);
      for (const skill of expected) {
        expect(loaded.content, `${key} -> ${skill}`).toContain(
          `Lifecycle skill: ${skill}@${LIFECYCLE_SKILLS[skill].version}`,
        );
      }
      if (expected.length === 0) {
        expect(loaded.content).not.toContain("Canonical software-development lifecycle guidance");
      }
    }
  });

  it("changes only consuming composed hashes when one skill changes", async () => {
    const requirementsPath = LIFECYCLE_SKILLS["requirements-to-acceptance"].skillPath;
    const changedReader = overridingReader({
      [requirementsPath]: current => current.replace(
        "Restate the goal in one or two plain sentences.",
        "Restate the goal and the observable user outcome in one or two plain sentences.",
      ),
    });

    const planningBefore = await loadAgenticPrompt(
      "technical_lead:planning",
      variablesFor("technical_lead:planning"),
      branchReader,
    );
    const planningAfter = await loadAgenticPrompt(
      "technical_lead:planning",
      variablesFor("technical_lead:planning"),
      changedReader,
    );
    const operationsBefore = await loadAgenticPrompt(
      "technical_lead:operations_review",
      variablesFor("technical_lead:operations_review"),
      branchReader,
    );
    const operationsAfter = await loadAgenticPrompt(
      "technical_lead:operations_review",
      variablesFor("technical_lead:operations_review"),
      changedReader,
    );

    expect(planningAfter.contentHash).toBe(planningBefore.contentHash);
    expect(planningAfter.lifecycleSkillSetHash).not.toBe(planningBefore.lifecycleSkillSetHash);
    expect(planningAfter.composedContentHash).not.toBe(planningBefore.composedContentHash);
    expect(planningAfter.renderedContentHash).not.toBe(planningBefore.renderedContentHash);

    expect(operationsAfter.contentHash).toBe(operationsBefore.contentHash);
    expect(operationsAfter.lifecycleSkillSetHash).toBe(operationsBefore.lifecycleSkillSetHash);
    expect(operationsAfter.composedContentHash).toBe(operationsBefore.composedContentHash);
    expect(operationsAfter.renderedContentHash).toBe(operationsBefore.renderedContentHash);
  });

  it("fails closed for missing markers, version drift, and duplicate injection", async () => {
    const skill = LIFECYCLE_SKILLS["requirements-to-acceptance"];

    await expect(loadLifecycleSkillGuidance(
      [skill.key],
      overridingReader({
        [skill.skillPath]: current => current.replace(RUNTIME_GUIDANCE_END, ""),
      }),
    )).rejects.toThrow("exactly one runtime guidance block");

    await expect(loadLifecycleSkillGuidance(
      [skill.key],
      overridingReader({
        [skill.manifestPath]: current => current.replace('"version": "1.0.0"', '"version": "2.0.0"'),
      }),
    )).rejects.toThrow("version mismatch");

    await expect(loadLifecycleSkillGuidance(
      [skill.key, skill.key],
      branchReader,
    )).rejects.toThrow("contains duplicates");
  });

  it("produces stable skill and prompt hashes for provider fallback", async () => {
    const key: AgenticPromptKey = "technical_lead:planning";
    const first = await loadAgenticPrompt(key, variablesFor(key), branchReader);
    const fallback = await loadAgenticPrompt(key, variablesFor(key), branchReader);

    expect(fallback.contentHash).toBe(first.contentHash);
    expect(fallback.lifecycleSkills).toEqual(first.lifecycleSkills);
    expect(fallback.lifecycleSkillSetHash).toBe(first.lifecycleSkillSetHash);
    expect(fallback.composedContentHash).toBe(first.composedContentHash);
    expect(fallback.renderedContentHash).toBe(first.renderedContentHash);
  });
});
