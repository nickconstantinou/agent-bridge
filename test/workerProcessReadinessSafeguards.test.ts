import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("worker process readiness safeguards", () => {
  it("runs exact-head checks for stacked pull requests and supports manual dispatch", () => {
    const ci = read(".github/workflows/ci.yml");
    const architectureLint = read(".github/workflows/architecture-lint.yml");

    for (const workflow of [ci, architectureLint]) {
      expect(workflow).toContain("pull_request:");
      expect(workflow).toContain("workflow_dispatch:");
      expect(workflow).not.toMatch(/pull_request:\s*\n\s+branches:\s*\[main\]/);
    }
    expect(ci).toContain("npm test");
    expect(ci).toContain("npm run typecheck");
    expect(architectureLint).toContain("bash scripts/arch-lint.sh src");
  });

  it("blocks behavioural work without an execution-capable isolated worktree", () => {
    const planning = read("prompts/worker/roles/technical-lead-planning.md");
    const red = read("prompts/worker/roles/code-worker-red.md");

    for (const requirement of [
      "clean isolated non-production worktree",
      "locked dependencies",
      "focused",
      "independent-review lane",
    ]) {
      expect(`${planning}\n${red}`, requirement).toContain(requirement);
    }
    expect(red).toMatch(/return `blocked` before changing files/i);
  });

  it("requires an empirically observed intended red failure before green", () => {
    const red = read("prompts/worker/roles/code-worker-red.md");
    const green = read("prompts/worker/roles/code-worker-green.md");

    expect(red).toContain("expected_failure_confirmed");
    expect(red).toContain("false-positive controls");
    expect(green).toContain("observed-red");
    expect(green).toContain("expected_failure_confirmed");
    expect(green).toMatch(/must not start.*not_run|not_run.*must not start/is);
    expect(green).toMatch(/return `blocked` before modifying production files/i);
  });

  it("guards GitHub issue mutation and verifies the stored result", () => {
    const issueAuthoring = read("prompts/worker/roles/technical-lead-issue-authoring.md");
    const decomposition = read("prompts/worker/roles/technical-lead-decomposition-review.md");

    for (const requirement of [
      "pre-mutation body",
      "revision",
      "guarded update",
      "refetch",
      "semantically",
      "Do not reconstruct",
    ]) {
      expect(`${issueAuthoring}\n${decomposition}`, requirement).toContain(requirement);
    }
  });

  it("keeps documentation trigger-bounded and fully validates broad rewrites", () => {
    const author = read("prompts/worker/roles/documentation-steward-author.md");
    const validate = read("prompts/worker/roles/documentation-steward-validate.md");

    expect(author).toContain("trigger-bounded");
    expect(author).toContain("broad rewrite");
    expect(author).toContain("whole document");
    expect(validate).toContain("full_document_revalidated");
    expect(validate).toContain("unrelated_or_unproven");
  });

  it("defines independent review by Technical Lead and Code Worker separation", () => {
    const implementationReview = read(
      "prompts/worker/roles/technical-lead-implementation-review.md",
    );
    const readiness = read("prompts/worker/roles/technical-lead-pr-readiness.md");
    const manifest = read("agentic-maintenance.yaml");
    const safeguards = read(
      "docs/implementation-plans/issue-159-execution-readiness-safeguards.md",
    );

    for (const requirement of [
      "reviewer_role_is_technical_lead",
      "technical_lead_advisor_review_satisfies_independence: true",
      "code_worker_can_review_own_implementation: false",
      "same_cli_and_model_allowed: true",
      "provider_model_diversity_required: false",
      "block_when_model_diversity_unavailable: false",
    ]) {
      expect(manifest, requirement).toContain(requirement);
    }

    expect(`${implementationReview}\n${readiness}`).toMatch(
      /same frontier model or CLI|same frontier model|same CLI or model/i,
    );
    expect(`${implementationReview}\n${readiness}`).toMatch(
      /did not author or modify the implementation|did not author or modify the reviewed implementation/i,
    );
    expect(safeguards).toContain("Independent Technical Lead review");
    expect(safeguards).toMatch(/role and authority separation/i);
    expect(safeguards).toMatch(/does not require an endlessly new model/i);
  });

  it("places the fresh Technical Lead final review after exact-head CI", () => {
    const manifest = read("agentic-maintenance.yaml");
    const architecture = read("docs/architecture/agentic-worker-orchestration.md");
    const promptContract = read("docs/architecture/agentic-prompt-contracts.md");

    expect(manifest).toMatch(
      /technical_lead_pr_readiness\s*\n\s*- exact_head_ci\s*\n\s*- technical_lead_final_review\s*\n\s*- human_merge_gate/,
    );
    expect(manifest).toContain("block_on_missing_final_technical_lead_review: true");
    expect(manifest).toMatch(
      /code_change_invalidates:[\s\S]*technical_lead_final_review/,
    );
    expect(architecture).toMatch(
      /exact-head CI\s*\n→ fresh exact-head Technical Lead final review\s*\n→ human merge gate/,
    );
    expect(promptContract).toContain("does not create a fourth role");
    expect(promptContract).toContain("technical_lead_final_review");
  });

  it("makes every new safeguard a blocking readiness input", () => {
    const readiness = read("prompts/worker/roles/technical-lead-pr-readiness.md");
    const manifest = read("agentic-maintenance.yaml");
    const safeguards = read(
      "docs/implementation-plans/issue-159-execution-readiness-safeguards.md",
    );

    for (const requirement of [
      "execution_preflight_status",
      "observed_red_status",
      "stacked_ci_status",
      "issue_mutation_integrity",
      "documentation_scope_status",
      "independent_review_lane_status",
    ]) {
      expect(readiness, requirement).toContain(requirement);
    }

    for (const requirement of [
      "behavioural_mutation_blocked_when_execution_preflight_fails: true",
      "green_blocked_without_observed_red: true",
      "pull_request_all_base_branches: true",
      "conflict_or_failed_validation_blocks_workflow: true",
      "unrelated_or_unproven_rewrite_blocks_readiness: true",
      "preflight_required_lane_before_behavioural_mutation: true",
    ]) {
      expect(manifest, requirement).toContain(requirement);
    }

    expect(safeguards).toContain("READY FOR HUMAN REVIEW");
    expect(safeguards).toContain("NOT READY FOR HUMAN REVIEW");
  });
});
