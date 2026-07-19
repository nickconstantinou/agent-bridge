import { describe, expect, it } from "vitest";
import {
  AGENT_ROLE_IDS,
  AGENT_ROLE_MODES,
  RoleAssignmentConfigError,
} from "../src/agentRoles.js";
import { loadBotsConfig, loadRoleAssignmentConfig } from "../src/config.js";
import { resolveWorkerCliPolicy } from "../src/workerCliPolicy.js";

const acceptedAssignments = [
  {
    role: "technical_lead",
    selection: "manual",
    primary: { cli: "claude", model: "claude-fable-5" },
    fallbacks: [{ cli: "codex", model: "gpt-5.6-sol" }],
  },
  {
    role: "code_worker",
    selection: "recommended",
    primary: { cli: "codex", model: "gpt-5.6-sol" },
    fallbacks: [{ cli: "claude", model: "claude-sonnet-5" }],
  },
  {
    role: "documentation_steward",
    selection: "automatic",
    primary: { cli: "antigravity", model: "gemini-3.1-pro" },
    fallbacks: [],
  },
] as const;

function envWith(assignments: unknown): Record<string, string | undefined> {
  return {
    WORKER_ROLE_ASSIGNMENTS_JSON: JSON.stringify(assignments),
    WORKER_ROLE_ASSIGNMENT_SCOPE: "workspace:agent-bridge",
  };
}

function captureConfigError(assignments: unknown): RoleAssignmentConfigError {
  try {
    loadRoleAssignmentConfig(envWith(assignments));
  } catch (error) {
    expect(error).toBeInstanceOf(RoleAssignmentConfigError);
    return error as RoleAssignmentConfigError;
  }
  throw new Error("expected role assignment configuration to fail");
}

describe("role assignment configuration", () => {
  it("parses exactly the three accepted roles and their accepted modes", () => {
    const config = loadRoleAssignmentConfig(envWith(acceptedAssignments));

    expect(AGENT_ROLE_IDS).toEqual([
      "technical_lead",
      "code_worker",
      "documentation_steward",
    ]);
    expect(AGENT_ROLE_MODES).toEqual({
      technical_lead: [
        "requirements",
        "issue_validation",
        "issue_authoring",
        "decomposition_review",
        "planning",
        "planning_repair",
        "executor_guidance",
        "implementation_review",
        "operations_review",
        "pr_readiness",
      ],
      code_worker: ["scan", "investigate", "red", "green", "repair", "verify"],
      documentation_steward: ["impact", "author", "validate", "maintenance"],
    });
    expect(config).not.toBeNull();
    expect(config).toMatchObject({
      scopeKey: "workspace:agent-bridge",
      source: "environment",
      status: "configured_dormant",
      assignments: acceptedAssignments,
    });
    expect(config!.idempotencyKey).toMatch(/^environment:[a-f0-9]{64}$/);
  });

  it.each([
    "scanner",
    "reviewer",
    "operations",
    "requirements",
    "issue_validation",
    "issue_authoring",
    "decomposition_review",
    "planning",
    "planning_repair",
    "executor_guidance",
    "implementation_review",
    "operations_review",
    "pr_readiness",
    "scan",
    "investigate",
    "red",
    "green",
    "repair",
    "verify",
    "impact",
    "author",
    "validate",
    "maintenance",
    "unknown_role",
  ])("rejects %s as a configurable role", (role) => {
    const error = captureConfigError([{ ...acceptedAssignments[0], role }]);
    expect(error.code).toBe("invalid_role");
    expect(error.message).toContain(role);
  });

  it("rejects duplicate role assignments deterministically", () => {
    const error = captureConfigError([
      acceptedAssignments[0],
      { ...acceptedAssignments[0], primary: { cli: "codex", model: "gpt-5.6-sol" } },
    ]);
    expect(error.code).toBe("duplicate_role");
    expect(error.message).toContain("technical_lead");
  });

  it.each([
    ["token", "provider-token"],
    ["api_key", "provider-api-key"],
    ["prompt_text", "raw-prompt"],
    ["repository_content", "raw-repository-content"],
  ])("rejects credential or content-shaped field %s", (field, value) => {
    const primary = { ...acceptedAssignments[0].primary, [field]: value };
    const error = captureConfigError([{ ...acceptedAssignments[0], primary }]);
    expect(error.code).toBe("forbidden_field");
    expect(error.message).toContain(field);
    expect(error.message).not.toContain(value);
  });

  it("keeps existing bot and legacy worker policy parsing unchanged", () => {
    const bots = loadBotsConfig({
      CODEX_COMMAND: "codex-custom",
      CODEX_MODEL_PREFERENCE: "gpt-a,gpt-b",
    });
    const policy = resolveWorkerCliPolicy({
      WORKER_CLI_CHAIN: "claude,codex,antigravity",
      WORKER_CODE_CLI_CHAIN: "codex,claude",
      WORKER_SCRIBE_CLI_CHAIN: "antigravity,claude",
    } as NodeJS.ProcessEnv);

    expect(bots.codex).toMatchObject({
      command: "codex-custom",
      modelPreference: ["gpt-a", "gpt-b"],
    });
    expect(policy).toEqual({
      interactiveChain: ["claude", "codex", "antigravity"],
      codeChain: ["codex", "claude"],
      scribeChain: ["antigravity", "claude"],
    });
  });
});
