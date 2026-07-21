/**
 * PURPOSE: Job handler for defect_scan task type.
 * Builds a repository analysis prompt (churn + typecheck), runs it through
 * a CLI, scores findings by impact/effort, generates TDD implementation plans,
 * pushes each finding to GitHub as an issue, and creates linked work_items.
 * NEIGHBORS: src/jobExecutor.ts, src/db.ts, src/cli.ts
 */

import type { JobHandler, JobHandlerInput, JobHandlerContext, JobHandlerResult } from "../jobExecutor.js";
import { createWorkerPromptFileReader } from "../workerPromptFileReader.js";
import { loadWorkerPrompt } from "../workerPrompts.js";

type RunCli = (command: string, args: string[], cwd?: string) => Promise<string>;
type RunCommand = (binary: string, args: string[]) => Promise<string>;

const TOP_N_FINDINGS = 3;
const promptReader = createWorkerPromptFileReader();
const GH_PR = "pr";
const GH_ISSUE = "issue";
const GH_COMMENT = "comment";
const GH_CREATE = "create";

function notifyFields(input: JobHandlerInput): Record<string, number> {
  return {
    ...(typeof input.notify_chat_id === "number" ? { notify_chat_id: input.notify_chat_id } : {}),
    ...(typeof input.notify_thread_id === "number" ? { notify_thread_id: input.notify_thread_id } : {}),
  };
}

interface DefectScanDeps {
  runCli: RunCli;
  command?: string;
  /** Map a repository name to its local checkout; null when unknown. */
  resolveRepoPath?: (repository: string) => string | null;
  /** When true, runs a second CLI pass to approve/reject each finding automatically. */
  autoTriage?: boolean;
  /** When provided, creates GitHub issues for each top finding inline. */
  runCommand?: RunCommand;
  /** Max findings to plan and push. Defaults to 3. */
  topN?: number;
  prepareWorkspace?: (repository: string, workItemId: number) => Promise<string>;
  cleanupWorkspace?: (dir: string) => void;
}

interface DefectFinding {
  title: string;
  impact?: string;
  confidence?: string;
  evidence?: string;
  /** Numeric severity 1–10 (10 = critical). */
  impact_score?: number;
  /** Numeric effort to fix 1–10 (1 = trivial, 10 = major surgery). */
  effort_score?: number;
}

async function buildScanPrompt( repository: string, prChangedFiles = ""): Promise<string> {
  return loadWorkerPrompt(
    "defect_scan:scan",
    {
      repository,
      pr_changed_files: prChangedFiles,
      typecheck_output: "",
    },
    promptReader,
  );
}

async function buildPlanPrompt( finding: DefectFinding, repository: string): Promise<string> {
  return loadWorkerPrompt(
    "defect_scan:plan",
    {
      repository,
      title: finding.title,
      evidence: finding.evidence ?? "see repository",
      impact: finding.impact ?? "unknown",
      impact_score: String(finding.impact_score ?? "?"),
      effort_score: String(finding.effort_score ?? "?"),
    },
    promptReader,
  );
}

async function buildTriagePrompt(
  repository: string,
  findings: Array<{ title: string; evidence?: string; confidence?: string; impact?: string }>,
): Promise<string> {
  const findingsText = findings.map((f, i) =>
    `${i + 1}. Title: ${f.title}\n   Evidence: ${f.evidence ?? "none"}\n   Impact: ${f.impact ?? "unknown"}\n   Confidence: ${f.confidence ?? "unknown"}`
  ).join("\n\n");

  return loadWorkerPrompt(
    "defect_scan:triage",
    { repository, findings: findingsText },
    promptReader,
  );
}

function parseFindings(output: string): DefectFinding[] {
  const findings: DefectFinding[] = [];
  const blockRegex = /- \*{0,2}Title\*{0,2}:\s*(.+?)(?=\n- \*{0,2}Title\*{0,2}:|\nOVERALL:|$)/gs;
  for (const match of output.matchAll(blockRegex)) {
    const block = match[1] + (match[0].slice(match[0].indexOf(match[1]) + match[1].length));
    const titleMatch = match[0].match(/- \*{0,2}Title\*{0,2}:\s*\*{0,2}\s*(.+?)\s*(?:\r?\n|$)/i);
    const title = (titleMatch?.[1] ?? match[1]).replace(/^\*+|\*+$/g, "").trim();
    if (!title) continue;

    const impactMatch = block.match(/\*{0,2}Impact\*{0,2}:\s*\*{0,2}\s*(.+?)\s*(?:\r?\n|$)/i);
    const confidenceMatch = block.match(/\*{0,2}Confidence\*{0,2}:\s*\*{0,2}\s*(.+?)\s*(?:\r?\n|$)/i);
    const evidenceMatch = block.match(/\*{0,2}Evidence\*{0,2}:\s*\*{0,2}\s*(.+?)\s*(?:\r?\n|$)/i);
    const impactScoreMatch = block.match(/\*{0,2}ImpactScore\*{0,2}:\s*\*{0,2}\s*(\d+)/i);
    const effortScoreMatch = block.match(/\*{0,2}EffortScore\*{0,2}:\s*\*{0,2}\s*(\d+)/i);

    findings.push({
      title,
      impact: impactMatch?.[1]?.replace(/^\*+|\*+$/g, "")?.trim(),
      confidence: confidenceMatch?.[1]?.replace(/^\*+|\*+$/g, "")?.trim()?.toLowerCase(),
      evidence: evidenceMatch?.[1]?.replace(/^\*+|\*+$/g, "")?.trim(),
      impact_score: impactScoreMatch ? Number(impactScoreMatch[1]) : undefined,
      effort_score: effortScoreMatch ? Number(effortScoreMatch[1]) : undefined,
    });
  }
  return findings;
}

function valueScore(f: DefectFinding): number {
  const impact = f.impact_score ?? 5;
  const effort = f.effort_score ?? 5;
  return effort > 0 ? impact / effort : 0;
}

function extractSummaryLine(output: string): string {
  const match = output.match(/OVERALL:\s*(.+)/i);
  if (match) return match[1].trim();
  if (!output.trim()) return "No output returned from scan.";
  const lines = output.split("\n").map(l => l.trim()).filter(Boolean);
  return lines.at(-1) ?? "Scan complete.";
}

function parseIssueNumber(url: string): number | null {
  const match = url.trim().match(/\/issues\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function buildIssueBody(finding: DefectFinding, planText: string, repository: string): string {
  const scoreTable = [
    `| Field | Value |`,
    `|---|---|`,
    `| Repository | ${repository} |`,
    `| Impact | ${finding.impact ?? "unknown"} |`,
    `| Impact score | ${finding.impact_score ?? "?"}/10 |`,
    `| Effort score | ${finding.effort_score ?? "?"}/10 |`,
    `| Value score | ${finding.impact_score && finding.effort_score ? (finding.impact_score / finding.effort_score).toFixed(2) : "?"} |`,
    `| Confidence | ${finding.confidence ?? "unknown"} |`,
  ].join("\n");

  return [
    `## Defect: ${finding.title}`,
    "",
    finding.evidence ? `**Evidence:** ${finding.evidence}` : "",
    "",
    scoreTable,
    "",
    "---",
    "",
    planText,
    "",
    "---",
    "*Created by agent-bridge defect scanner. Approve via Telegram to begin implementation.*",
  ].filter(l => l !== null).join("\n");
}

interface TriageDecision {
  index: number;
  decision: "APPROVE" | "REJECT";
  reason?: string;
}

function parseTriageDecisions(output: string): TriageDecision[] {
  const jsonMatch = output.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  try {
    const parsed = JSON.parse(jsonMatch[0]) as unknown[];
    return parsed.filter(
      (d): d is TriageDecision =>
        typeof d === "object" && d !== null &&
        typeof (d as any).index === "number" &&
        ((d as any).decision === "APPROVE" || (d as any).decision === "REJECT"),
    );
  } catch {
    return [];
  }
}

export function createDefectScanHandler(deps: DefectScanDeps): JobHandler {
  const { runCli, command = "claude", resolveRepoPath, autoTriage = false, runCommand, topN = TOP_N_FINDINGS, prepareWorkspace, cleanupWorkspace } = deps;

  return async function defectScanHandler(
    input: JobHandlerInput,
    ctx: JobHandlerContext,
  ): Promise<JobHandlerResult> {
    const repository = typeof input.repository === "string" ? input.repository : "unknown";

    let scanCwd: string | undefined;
    let didPrepareWorkspace = false;

    try {
      if (input.branch_name && input.work_item_id && prepareWorkspace) {
        scanCwd = await prepareWorkspace(repository, Number(input.work_item_id));
        didPrepareWorkspace = true;
        if (runCommand) {
          await runCommand("git", ["checkout", String(input.branch_name)]).catch(() => {});
        }
      } else if (resolveRepoPath) {
        const resolved = resolveRepoPath(repository);
        if (!resolved) {
          throw new Error(`No local checkout found for repository '${repository}' — cannot scan`);
        }
        scanCwd = resolved;
      }

      let prChangedFiles = "";
      if (input.pr_mode && runCommand) {
        try {
          const diffFiles = await runCommand("git", ["diff", "--name-only", "origin/main...HEAD"]);
          if (diffFiles.trim()) prChangedFiles = diffFiles.trim();
        } catch {}
      }

      const prompt = await buildScanPrompt( repository, prChangedFiles);
      const rawOutput = await runCli(command, ["--print", "--output-format", "text", prompt], scanCwd);

      const findings = parseFindings(rawOutput);
      const summaryLine = extractSummaryLine(rawOutput);

      const actionableFindings = findings
        .filter(f => f.confidence === "high" || f.confidence === "medium")
        .sort((a, b) => valueScore(b) - valueScore(a))
        .slice(0, topN);

      if (input.pr_mode) {
        if (input.pr_number && runCommand) {
          const commentBody = actionableFindings.length > 0
            ? `### pre-merge defect scan findings\n\n${actionableFindings.map((f, i) => `${i + 1}. **${f.title}** (Impact: ${f.impact}, Confidence: ${f.confidence})\n   Evidence: ${f.evidence}`).join("\n\n")}`
            : `### pre-merge defect scan findings\n\nNo issues found.`;

          await runCommand("gh", [
            GH_PR, GH_COMMENT, String(input.pr_number),
            "--repo", repository,
            "--body", commentBody,
          ]).catch(err => console.warn("[defect-scan] failed to post PR comment", err));
        }

        if (actionableFindings.length > 0) {
          throw new Error(`Defect scan failed: found ${actionableFindings.length} potential issues.`);
        }
        return { summary: "Pre-merge defect scan completed: no issues found." };
      }

      const createdItems: Array<{ itemId: number; finding: DefectFinding }> = [];

      for (const f of actionableFindings) {
        let planText = "";
        try {
          const planPrompt = await buildPlanPrompt( f, repository);
          planText = await runCli(command, ["--print", "--output-format", "text", planPrompt], scanCwd);
        } catch (err) {
          console.warn("[defect-scan] plan generation failed for:", f.title, err);
          planText = `Evidence: ${f.evidence ?? "see repository"}\nImpact: ${f.impact ?? "unknown"}\nConfidence: ${f.confidence ?? "unknown"}`;
        }

        const body = [
          f.evidence ? `Evidence: ${f.evidence}` : null,
          f.impact ? `Impact: ${f.impact}` : null,
          f.impact_score != null ? `ImpactScore: ${f.impact_score}/10` : null,
          f.effort_score != null ? `EffortScore: ${f.effort_score}/10` : null,
          `Confidence: ${f.confidence}`,
          `Source: defect_scan of ${repository}`,
          "",
          planText.slice(0, 4000),
        ].filter(s => s !== null).join("\n");

        const item = ctx.db.createWorkItem({
          kind: "defect",
          source: "defect_scan",
          repository,
          title: f.title,
          body,
          created_by: "worker",
        });

        if (runCommand) {
          try {
            const issueBody = buildIssueBody(f, planText, repository);
            const issueUrl = await runCommand("gh", [
              GH_ISSUE, GH_CREATE,
              "--repo", repository,
              "--title", f.title,
              "--body", issueBody.slice(0, 65000),
              "--label", "bug,agent-proposed",
            ]);
            const issueNumber = parseIssueNumber(issueUrl);
            if (issueNumber !== null) {
              ctx.db.linkGithubIssue({ work_item_id: item.id, repository, issue_number: issueNumber });
            }
          } catch (err) {
            console.warn("[defect-scan] GitHub issue creation failed for:", f.title, err);
          }
        }

        createdItems.push({ itemId: item.id, finding: f });
      }

      if (autoTriage && createdItems.length > 0) {
        const triagePrompt = await buildTriagePrompt( repository, actionableFindings);
        const triageOutput = await runCli(command, ["--print", "--output-format", "text", triagePrompt], scanCwd);
        const decisions = parseTriageDecisions(triageOutput);
        const notify = notifyFields(input);

        for (const decision of decisions) {
          const entry = createdItems[decision.index];
          if (!entry) continue;

          if (decision.decision === "APPROVE") {
            ctx.db.updateWorkItemStatus(entry.itemId, "approved");
            const hasLinkedIssue = (ctx.db.raw.prepare(
              `SELECT 1 FROM github_links WHERE work_item_id = ? AND issue_number IS NOT NULL LIMIT 1`,
            ).get(entry.itemId) as { 1: number } | undefined) != null;

            if (!hasLinkedIssue && repository) {
              ctx.db.createWorkJob({
                task_type: "open_github_issue",
                idempotency_key: `gh_issue:${entry.itemId}`,
                work_item_id: entry.itemId,
                input_json: {
                  work_item_id: entry.itemId,
                  repository,
                  ...notify,
                },
              });
            }
            ctx.db.createWorkJob({
              task_type: "tdd_implementation",
              idempotency_key: `tdd:${entry.itemId}`,
              work_item_id: entry.itemId,
              input_json: {
                work_item_id: entry.itemId,
                ...(repository ? { repository } : {}),
                ...notify,
              },
            });
          } else {
            ctx.db.updateWorkItemStatus(entry.itemId, "closed");
          }
        }
      }

      const created = createdItems.length;
      const topScores = actionableFindings
        .map(f => `${f.title} (value: ${valueScore(f).toFixed(1)})`)
        .join(", ");

      const summary = created > 0
        ? `${summaryLine} — top ${created} ranked: ${topScores}`
        : summaryLine;

      return { summary, rawOutput, findings, work_item_ids: createdItems.map(item => item.itemId) };
    } finally {
      if (didPrepareWorkspace && scanCwd && cleanupWorkspace) {
        cleanupWorkspace(scanCwd);
      }
    }
  };
}
