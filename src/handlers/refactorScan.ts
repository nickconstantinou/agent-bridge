/**
 * PURPOSE: Job handler for refactor_scan task type.
 * Identifies highest-value refactoring opportunities by scoring impact/effort,
 * generates TDD implementation plans, and pushes each finding to GitHub as an issue.
 * NEIGHBORS: src/jobExecutor.ts, src/index-worker.ts
 */

import type { JobHandler, JobHandlerInput, JobHandlerContext } from "../jobExecutor.js";
import { resolveLocalRepoPath } from "../workspace.js";

type RunCli = (command: string, args: string[], cwd?: string) => Promise<string>;
type RunCommand = (binary: string, args: string[]) => Promise<string>;

const TOP_N_FINDINGS = 3;

interface RefactorScanDeps {
  runCli: RunCli;
  command?: string;
  resolveRepoPath?: (repository: string) => string | null;
  /** When provided, creates GitHub issues for each top finding inline. */
  runCommand?: RunCommand;
  /** Max findings to plan and push. Defaults to 3. */
  topN?: number;
}

interface RefactorFinding {
  title: string;
  rationale?: string;
  files?: string[];
  /** Value delivered by the refactor 1–10. */
  impact_score?: number;
  /** Implementation effort 1–10 (1=trivial, 10=requires major restructure). */
  effort_score?: number;
}

function buildPrompt(repository: string): string {
  return `You are performing a read-only refactoring analysis of the repository: ${repository}.

Your task:
1. Examine the repository structure, key source files, and TypeScript/JS patterns.
2. Identify up to 5 concrete refactoring opportunities: dead code, duplicated logic, oversized files, unclear boundaries, or naming that harms readability.
3. Score each opportunity on two dimensions:
   - impact_score (1-10): value delivered — improved correctness, maintainability, or performance (10=transformative, 1=cosmetic).
   - effort_score (1-10): implementation cost (1=one-file rename, 10=cross-cutting restructure).
4. For each finding output a JSON object on its own line:
   {"title": "...", "rationale": "...", "files": ["..."], "impact_score": <1-10>, "effort_score": <1-10>}

Output only the JSON lines. No markdown, no prose.`;
}

function buildPlanPrompt(finding: RefactorFinding, repository: string): string {
  return `You are a senior TDD engineer. Generate a detailed, actionable implementation plan for this refactoring opportunity.

Repository: ${repository}
Title: ${finding.title}
Rationale: ${finding.rationale ?? "see repository"}
Files: ${finding.files?.join(", ") ?? "unspecified"}
Value score: ${finding.impact_score ?? "?"}/10
Effort score: ${finding.effort_score ?? "?"}/10

Produce the plan in these sections:

## Problem Statement
Explain the current problem and why refactoring is valuable in 2–3 sentences.

## Target Files
List each file that must change, and the specific change required.

## Red Test Specification
- Exact test file path
- Test framework command to run it
- The assertion that must FAIL before implementation starts
- Expected failure reason

## Implementation Phases
For each phase:
- Behaviour change description
- Red test (write first, commit separately)
- Green change (minimal refactor)
- Verification command
- Commit message

## Acceptance Criteria
3–5 verifiable criteria. Each must be checkable by running a command or reading a file.

Rules:
- Do NOT write any code yet — plan only.
- Every phase must test before refactoring.
- Keep phases small and independently releasable.`;
}

function parseFindings(output: string): RefactorFinding[] {
  return output
    .split("\n")
    .filter(l => l.trim().startsWith("{"))
    .map(l => { try { return JSON.parse(l) as RefactorFinding; } catch { return null; } })
    .filter((f): f is RefactorFinding => f !== null && typeof f.title === "string");
}

function valueScore(f: RefactorFinding): number {
  const impact = f.impact_score ?? 5;
  const effort = f.effort_score ?? 5;
  return effort > 0 ? impact / effort : 0;
}

function parseIssueNumber(url: string): number | null {
  const match = url.trim().match(/\/issues\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function buildIssueBody(finding: RefactorFinding, planText: string, repository: string): string {
  const scoreTable = [
    `| Field | Value |`,
    `|---|---|`,
    `| Repository | ${repository} |`,
    `| Impact score | ${finding.impact_score ?? "?"}/10 |`,
    `| Effort score | ${finding.effort_score ?? "?"}/10 |`,
    `| Value score | ${finding.impact_score && finding.effort_score ? (finding.impact_score / finding.effort_score).toFixed(2) : "?"} |`,
    finding.files?.length ? `| Files | ${finding.files.join(", ")} |` : null,
  ].filter(Boolean).join("\n");

  return [
    `## Refactor: ${finding.title}`,
    "",
    finding.rationale ? `**Rationale:** ${finding.rationale}` : "",
    "",
    scoreTable,
    "",
    "---",
    "",
    planText,
    "",
    "---",
    "*Created by agent-bridge refactor scanner. Approve via Telegram to begin implementation.*",
  ].filter(l => l !== null).join("\n");
}

export function createRefactorScanHandler(deps: RefactorScanDeps): JobHandler {
  const { runCli, command = "claude", resolveRepoPath = resolveLocalRepoPath, runCommand, topN = TOP_N_FINDINGS } = deps;

  return async function refactorScanHandler(input: JobHandlerInput, ctx: JobHandlerContext) {
    const repository = typeof input.repository === "string" ? input.repository : null;
    if (!repository) throw new Error("input.repository is required");

    const repoPath = resolveRepoPath(repository);
    const cwd = repoPath ?? process.cwd();

    const prompt = buildPrompt(repository);
    const output = await runCli(command, ["-p", prompt], cwd);

    const findings = parseFindings(output);

    // Rank by value score (impact/effort), take top N
    const ranked = findings
      .sort((a, b) => valueScore(b) - valueScore(a))
      .slice(0, topN);

    const workItemIds: number[] = [];
    for (const f of ranked) {
      // Plan generation pass
      let planText = "";
      try {
        planText = await runCli(command, ["-p", buildPlanPrompt(f, repository)], cwd);
      } catch (err) {
        console.warn("[refactor-scan] plan generation failed for:", f.title, err);
        planText = `Rationale: ${f.rationale ?? "see repository"}\nFiles: ${f.files?.join(", ") ?? "unspecified"}`;
      }

      const body = [
        f.rationale ? `Rationale: ${f.rationale}` : null,
        f.files?.length ? `Files: ${f.files.join(", ")}` : null,
        f.impact_score != null ? `ImpactScore: ${f.impact_score}/10` : null,
        f.effort_score != null ? `EffortScore: ${f.effort_score}/10` : null,
        "",
        planText.slice(0, 4000),
      ].filter(s => s !== null).join("\n");

      const item = ctx.db.createWorkItem({
        kind: "refactor",
        source: "refactor_scan",
        title: f.title,
        created_by: "worker",
        body,
        repository,
        priority: "normal",
      });

      // Create GitHub issue inline with full plan
      if (runCommand) {
        try {
          const issueBody = buildIssueBody(f, planText, repository);
          const issueUrl = await runCommand("gh", [
            "issue", "create",
            "--repo", repository,
            "--title", f.title,
            "--body", issueBody.slice(0, 65000),
            "--label", "refactor,agent-proposed",
          ]);
          const issueNumber = parseIssueNumber(issueUrl);
          if (issueNumber !== null) {
            ctx.db.linkGithubIssue({ work_item_id: item.id, repository, issue_number: issueNumber });
          }
        } catch (err) {
          console.warn("[refactor-scan] GitHub issue creation failed for:", f.title, err);
        }
      }

      workItemIds.push(item.id);
    }

    const topScores = ranked
      .map(f => `${f.title} (value: ${valueScore(f).toFixed(1)})`)
      .join(", ");

    return {
      summary: ranked.length > 0
        ? `Refactor scan of **${repository}** — top ${ranked.length} by value: ${topScores}`
        : `Refactor scan of **${repository}** found no refactoring opportunities.`,
      work_item_ids: workItemIds,
    };
  };
}
