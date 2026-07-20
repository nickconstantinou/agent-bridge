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
