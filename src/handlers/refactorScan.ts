/**
 * PURPOSE: Job handler for refactor_scan task type.
 * Identifies highest-value refactoring opportunities by scoring impact/effort,
 * generates TDD implementation plans, and pushes each finding to GitHub as an issue.
 * NEIGHBORS: src/jobExecutor.ts, src/index-worker.ts
 */

import type { JobHandler, JobHandlerInput, JobHandlerContext } from "../jobExecutor.js";
import { resolveLocalRepoPath } from "../workspace.js";
import { createWorkerPromptFileReader } from "../workerPromptFileReader.js";
import { loadWorkerPrompt } from "../workerPrompts.js";

type RunCli = (command: string, args: string[], cwd?: string) => Promise<string>;
type RunCommand = (binary: string, args: string[]) => Promise<string>;

const TOP_N_FINDINGS = 3;
const promptReader = createWorkerPromptFileReader();
const GH_ISSUE = "issue";
const GH_CREATE = "create";

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

async function buildScanPrompt( repository: string): Promise<string> {
  return loadWorkerPrompt(
    "refactor_scan:scan",
    { repository },
    promptReader,
  );
}

async function buildPlanPrompt( finding: RefactorFinding, repository: string): Promise<string> {
  return loadWorkerPrompt(
    "refactor_scan:plan",
    {
      repository,
      title: finding.title,
      rationale: finding.rationale ?? "see repository",
      files: finding.files?.join(", ") ?? "unspecified",
      impact_score: String(finding.impact_score ?? "?"),
      effort_score: String(finding.effort_score ?? "?"),
    },
    promptReader,
  );
}

export function createRefactorScanHandler(deps: RefactorScanDeps): JobHandler {
  const { runCli, command = "claude", resolveRepoPath = resolveLocalRepoPath, runCommand, topN = TOP_N_FINDINGS } = deps;

  return async function refactorScanHandler(input: JobHandlerInput, ctx: JobHandlerContext) {
    const repository = typeof input.repository === "string" ? input.repository : null;
    if (!repository) throw new Error("input.repository is required");

    const repoPath = resolveRepoPath(repository);
    const cwd = repoPath ?? process.cwd();

    const prompt = await buildScanPrompt( repository);
    const output = await runCli(command, ["-p", prompt], cwd);

    const findings = parseFindings(output);

    // Rank by value score (impact/effort), take top N
    const ranked = findings
      .sort((a, b) => valueScore(b) - valueScore(a))
      .slice(0, topN);

    const workItemIds: number[] = [];
    for (const f of ranked) {
      let planText = "";
      try {
        const planPrompt = await buildPlanPrompt( f, repository);
        planText = await runCli(command, ["-p", planPrompt], cwd);
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

      if (runCommand) {
        try {
          const issueBody = buildIssueBody(f, planText, repository);
          const issueUrl = await runCommand("gh", [
            GH_ISSUE, GH_CREATE,
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
