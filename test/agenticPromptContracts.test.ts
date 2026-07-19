import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENTIC_PROMPT_CONTRACTS,
  type AgenticPromptKey,
  getAgenticPromptContract,
  loadAgenticPrompt,
} from "../src/agenticPromptContracts.js";

const EXPECTED_KEYS: AgenticPromptKey[] = [
  "technical_lead:requirements",
  "technical_lead:issue_validation",
  "technical_lead:issue_authoring",
  "technical_lead:planning",
  "technical_lead:planning_repair:execution_contract",
  "technical_lead:planning_repair:red_tests",
  "technical_lead:executor_guidance",
  "technical_lead:implementation_review",
  "technical_lead:operations_review",
  "technical_lead:pr_readiness",
  "code_worker:scan:defect",
  "code_worker:scan:refactor",
  "code_worker:investigate",
  "code_worker:red",
  "code_worker:green",
  "code_worker:repair",
  "code_worker:verify",
  "documentation_steward:impact",
  "documentation_steward:author",
  "documentation_steward:validate",
  "documentation_steward:maintenance",
];

function readPrompt(key: AgenticPromptKey): string {
  const contract = getAgenticPromptContract(key);
  return readFileSync(resolve(process.cwd(), contract.filePath), "utf8");
}

describe("agentic role prompt contracts", () => {
  it("registers one source-controlled prompt for every role and mode", () => {
    expect(Object.keys(AGENTIC_PROMPT_CONTRACTS).sort()).toEqual([...EXPECTED_KEYS].sort());
    const paths = EXPECTED_KEYS.map((key) => getAgenticPromptContract(key).filePath);
    expect(new Set(paths).size).toBe(paths.length);

    for (const key of EXPECTED_KEYS) {
      const contract = getAgenticPromptContract(key);
      expect(contract.version).toBe(1);
      expect(contract.source).toBe("builtin");
      expect(contract.allowDatabaseOverride).toBe(false);
      expect(readPrompt(key).trim().length, key).toBeGreaterThan(120);
    }
  });

  it("loads a deterministic built-in prompt and records its content hash", async () => {
    const loaded = await loadAgenticPrompt(
      "technical_lead:requirements",
      { request: "Add role-aware planning", repository: "owner/repo" },
      { readText: async (path) => readFileSync(resolve(process.cwd(), path), "utf8") },
    );

    expect(loaded.key).toBe("technical_lead:requirements");
    expect(loaded.version).toBe(1);
    expect(loaded.source).toBe("builtin");
    expect(loaded.content).toContain("Add role-aware planning");
    expect(loaded.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires Technical Lead planning to cover product, architecture, and triggered risks", () => {
    const prompt = readPrompt("technical_lead:planning");
    for (const requirement of [
      "requirement_ids",
      "product",
      "architecture",
      "invariants",
      "risks",
      "production_boundary",
      "action_through_real_caller",
      "why_current_code_fails",
      "focused_red_command",
      "authoritative_oracle",
      "false_positive_controls",
      "acceptance_coverage",
      "architecture_coverage",
      "triggered_risk_coverage",
    ]) {
      expect(prompt, requirement).toContain(requirement);
    }
    expect(prompt).toMatch(/write tests|add tests/i);
    expect(prompt).toMatch(/invalid|reject|must not/i);
  });

  it("keeps red-test and execution-contract repairs section-specific", () => {
    const redRepair = readPrompt("technical_lead:planning_repair:red_tests");
    const contractRepair = readPrompt("technical_lead:planning_repair:execution_contract");

    expect(redRepair).toContain("red_tests");
    expect(redRepair).toContain("acceptance_coverage");
    expect(redRepair).not.toContain("target_files\": [\"repo-relative paths\"]");
    expect(contractRepair).toContain("Execution Contract");
    expect(contractRepair).not.toContain("acceptance_coverage");
    expect(redRepair).toMatch(/must not change/i);
    expect(contractRepair).toMatch(/must not change/i);
  });

  it("keeps execution and documentation prompts inside their permission intent", () => {
    expect(readPrompt("code_worker:red")).toMatch(/approved red-test|approved red test/i);
    expect(readPrompt("code_worker:red")).toMatch(/do not.*production|test-only/i);
    expect(readPrompt("code_worker:green")).toMatch(/committed red tests|leave.*tests unchanged/i);
    expect(readPrompt("documentation_steward:author")).toMatch(/documentation-only|approved documentation paths/i);
    expect(readPrompt("technical_lead:implementation_review")).toMatch(/deterministic evidence/i);
  });

  it("updates the active legacy planning prompts to require comprehensive red-test intent", () => {
    for (const path of [
      "prompts/worker/implementation-plan-create.md",
      "prompts/worker/implementation-plan-improve.md",
    ]) {
      const prompt = readFileSync(resolve(process.cwd(), path), "utf8");
      expect(prompt).toContain("## Red Tests");
      expect(prompt).toContain("product intent");
      expect(prompt).toContain("architectural");
      expect(prompt).toContain("real caller");
      expect(prompt).toContain("authoritative oracle");
      expect(prompt).toContain("sibling behaviour");
    }
  });
});
