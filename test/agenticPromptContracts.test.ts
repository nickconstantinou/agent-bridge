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
  "technical_lead:decomposition_review",
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

const reader = {
  readText: async (path: string) => readFileSync(resolve(process.cwd(), path), "utf8"),
};

function readPrompt(key: AgenticPromptKey): string {
  const contract = getAgenticPromptContract(key);
  return readFileSync(resolve(process.cwd(), contract.filePath), "utf8");
}

function requirementsVariables(request: string): Record<string, string> {
  return {
    repository: "owner/repo",
    request,
    source_context: "Imported issue",
    evidence_catalog: "E-1: current repository evidence",
    known_decisions: "No accepted decisions yet",
  };
}

describe("agentic role prompt contracts", () => {
  it("registers one source-controlled prompt for every role and mode", () => {
    expect(Object.keys(AGENTIC_PROMPT_CONTRACTS).sort()).toEqual([...EXPECTED_KEYS].sort());
    const paths = EXPECTED_KEYS.map((key) => getAgenticPromptContract(key).filePath);
    expect(new Set(paths).size).toBe(paths.length);

    for (const key of EXPECTED_KEYS) {
      const contract = getAgenticPromptContract(key);
      const prompt = readPrompt(key);
      const placeholders = [...prompt.matchAll(/\$?\{([A-Za-z0-9_]+)\}/g)].map(match => match[1]);

      expect(contract.version).toBe(1);
      expect(contract.source).toBe("builtin");
      expect(contract.allowDatabaseOverride).toBe(false);
      expect(prompt.trim().length, key).toBeGreaterThan(120);
      expect(new Set(placeholders), `${key} placeholder contract`).toEqual(new Set(contract.requiredVariables));
    }
  });

  it("records stable template identity separately from rendered invocation identity", async () => {
    const first = await loadAgenticPrompt(
      "technical_lead:requirements",
      requirementsVariables("Add role-aware planning"),
      reader,
    );
    const second = await loadAgenticPrompt(
      "technical_lead:requirements",
      requirementsVariables("Investigate a queue defect"),
      reader,
    );

    expect(first.key).toBe("technical_lead:requirements");
    expect(first.version).toBe(1);
    expect(first.source).toBe("builtin");
    expect(first.content).toContain("Add role-aware planning");
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.renderedContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.renderedContentHash).not.toBe(second.renderedContentHash);
  });

  it("fails closed when a required prompt input is absent", async () => {
    await expect(loadAgenticPrompt(
      "technical_lead:requirements",
      { repository: "owner/repo", request: "Incomplete context" },
      reader,
    )).rejects.toThrow(
      "Missing required variables for technical_lead:requirements: source_context, evidence_catalog, known_decisions",
    );
  });

  it("treats null or undefined required prompt inputs as missing", async () => {
    for (const value of [null, undefined]) {
      await expect(loadAgenticPrompt(
        "technical_lead:requirements",
        { ...requirementsVariables("Incomplete context"), known_decisions: value },
        reader,
      )).rejects.toThrow(
        "Missing required variables for technical_lead:requirements: known_decisions",
      );
    }
  });

  it("bounds supplied prompt context before rendering", async () => {
    const loaded = await loadAgenticPrompt(
      "technical_lead:requirements",
      {
        ...requirementsVariables("A".repeat(20_000)),
      },
      reader,
    );

    expect(loaded.content).toContain("[truncated 4000 chars for worker prompt budget]");
    expect(loaded.content.length).toBeLessThan(20_000);
  });

  it("requires Technical Lead planning to cover product, architecture, triggered risks, and path provenance", () => {
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
      "classification",
      "existing_at_base",
      "existing_in_dependency",
      "proposed_new_production",
      "proposed_new_test",
      "dependency_ref",
    ]) {
      expect(prompt, requirement).toContain(requirement);
    }
    expect(prompt).toMatch(/write tests|add tests/i);
    expect(prompt).toMatch(/invalid|reject|must not/i);
  });

  it("requires a bundle-wide decomposition review before issue mutation", () => {
    const prompt = readPrompt("technical_lead:decomposition_review");
    for (const requirement of [
      "ready_for_issue_mutation",
      "implementation_delivery_order",
      "runtime_phase_order",
      "invariant_matrix",
      "ownership_and_caller_conflicts",
      "state_and_lifecycle_authority_conflicts",
      "platform_appliance_authority_conflicts",
      "required_bundle_repairs",
    ]) {
      expect(prompt, requirement).toContain(requirement);
    }
    expect(prompt).toMatch(/before any GitHub issue mutation/i);
  });

  it("enforces review-before-documentation and exact-head invalidation", () => {
    const implementationReview = readPrompt("technical_lead:implementation_review");
    const documentationAuthor = readPrompt("documentation_steward:author");
    const documentationValidate = readPrompt("documentation_steward:validate");
    const readiness = readPrompt("technical_lead:pr_readiness");

    expect(implementationReview).toContain("subject_head_sha");
    expect(implementationReview).toContain("ready_for_documentation");
    expect(implementationReview).not.toContain("{documentation_evidence}");
    expect(documentationAuthor).toContain("{accepted_review_evidence}");
    expect(documentationAuthor).toContain("{subject_head_sha}");
    expect(documentationValidate).toContain("{accepted_review_evidence}");
    expect(documentationValidate).toContain("{subject_head_sha}");
    expect(readiness).toContain("{subject_head_sha}");
    expect(readiness).toContain("not_scheduled");
    expect(readiness).toMatch(/code-changing repair|different head|same `subject_head_sha`/i);
  });

  it("makes stale required documentation a blocking condition", () => {
    for (const key of [
      "technical_lead:planning",
      "technical_lead:pr_readiness",
      "documentation_steward:author",
      "documentation_steward:validate",
      "documentation_steward:maintenance",
    ] as const) {
      const prompt = readPrompt(key);
      expect(prompt, key).toMatch(/stale/i);
      expect(prompt, key).toMatch(/block|cannot be deferred|do not defer|same delivery/i);
    }
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
      expect(prompt).toContain("classification");
      expect(prompt).toContain("dependency_ref");
    }
  });
});
