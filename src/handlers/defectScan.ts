/**
 * PURPOSE: Job handler for defect_scan task type.
 * Builds a repository analysis prompt (churn + typecheck), runs it through
 * a CLI, parses findings, and creates proposed work_items in the DB.
 * NEIGHBORS: src/jobExecutor.ts, src/db.ts, src/cli.ts
 */

import type { JobHandler, JobHandlerInput, JobHandlerContext, JobHandlerResult } from "../jobExecutor.js";

type RunCli = (command: string, args: string[], cwd?: string) => Promise<string>;

interface DefectScanDeps {
  runCli: RunCli;
  command?: string;
  /** Map a repository name to its local checkout; null when unknown. */
  resolveRepoPath?: (repository: string) => string | null;
  /** When true, runs a second CLI pass to approve/reject each finding automatically. */
  autoTriage?: boolean;
}

interface DefectFinding {
  title: string;
  impact?: string;
  confidence?: string;
  evidence?: string;
}

function buildPrompt(repository: string): string {
  return `You are performing a read-only defect scan of the repository: ${repository}.

Your job is to identify high-probability defects without modifying any code.

Steps to follow:

1. Examine the file tree (excluding node_modules, dist, build, .git).
2. Run: npm run typecheck
   Report any type errors as potential defects.
3. Analyse recent churn using:
   git log --since="90 days ago" --format=format: --name-only | sort | uniq -c | sort -rg | head -20
   Focus targeted inspection on the top churned files.
4. Cross-reference high-churn files with any typecheck output.
5. For each potential defect, output a finding block in this exact format:
   - Title: <short title>
     Impact: <High|Medium|Low>
     Confidence: <high|medium|low>
     Evidence: <one-line evidence note>

6. End your response with a line matching exactly:
   OVERALL: <N> potential issue(s) found.

Important constraints:
- Do NOT make any code changes.
- Only report issues you have direct evidence for in this repository.
- If you find no issues, output: OVERALL: 0 potential issues found.`;
}

function parseFindings(output: string): DefectFinding[] {
  const findings: DefectFinding[] = [];
  // Match blocks starting with Title, allowing optional surrounding asterisks
  const blockRegex = /- \*{0,2}Title\*{0,2}:\s*(.+?)(?=\n- \*{0,2}Title\*{0,2}:|\nOVERALL:|$)/gs;
  for (const match of output.matchAll(blockRegex)) {
    const block = match[1] + (match[0].slice(match[0].indexOf(match[1]) + match[1].length));
    const titleMatch = match[0].match(/- \*{0,2}Title\*{0,2}:\s*\*{0,2}\s*(.+?)\s*(?:\r?\n|$)/i);
    const title = (titleMatch?.[1] ?? match[1]).replace(/^\*+|\*+$/g, "").trim();
    if (!title) continue;

    const impactMatch = block.match(/\*{0,2}Impact\*{0,2}:\s*\*{0,2}\s*(.+?)\s*(?:\r?\n|$)/i);
    const confidenceMatch = block.match(/\*{0,2}Confidence\*{0,2}:\s*\*{0,2}\s*(.+?)\s*(?:\r?\n|$)/i);
    const evidenceMatch = block.match(/\*{0,2}Evidence\*{0,2}:\s*\*{0,2}\s*(.+?)\s*(?:\r?\n|$)/i);

    findings.push({
      title,
      impact: impactMatch?.[1]?.replace(/^\*+|\*+$/g, "")?.trim(),
      confidence: confidenceMatch?.[1]?.replace(/^\*+|\*+$/g, "")?.trim()?.toLowerCase(),
      evidence: evidenceMatch?.[1]?.replace(/^\*+|\*+$/g, "")?.trim(),
    });
  }
  return findings;
}

function extractSummaryLine(output: string): string {
  const match = output.match(/OVERALL:\s*(.+)/i);
  if (match) return match[1].trim();
  if (!output.trim()) return "No output returned from scan.";
  // Fallback: take last non-empty line
  const lines = output.split("\n").map(l => l.trim()).filter(Boolean);
  return lines.at(-1) ?? "Scan complete.";
}

interface TriageDecision {
  index: number;
  decision: "APPROVE" | "REJECT";
  reason?: string;
}

function buildTriagePrompt(repository: string, findings: Array<{ title: string; evidence?: string; confidence?: string; impact?: string }>): string {
  const list = findings.map((f, i) =>
    `${i + 1}. Title: ${f.title}\n   Evidence: ${f.evidence ?? "none"}\n   Impact: ${f.impact ?? "unknown"}\n   Confidence: ${f.confidence ?? "unknown"}`
  ).join("\n\n");

  return `You are a senior engineer evaluating defect scan findings for an automated TDD agent working on: ${repository}.

Review each finding and decide whether it should be auto-approved for immediate implementation.

${list}

Return ONLY a JSON array (no markdown fences, no explanation), one entry per finding in order:
[{"index":0,"decision":"APPROVE","reason":"..."},{"index":1,"decision":"REJECT","reason":"..."}]

Approve if: the finding is well-evidenced, reproducible, and safe to fix with a small targeted change.
Reject if: the finding is speculative, too broad, or would require risky structural changes.`;
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
  const { runCli, command = "claude", resolveRepoPath, autoTriage = false } = deps;

  return async function defectScanHandler(
    input: JobHandlerInput,
    ctx: JobHandlerContext,
  ): Promise<JobHandlerResult> {
    const repository = typeof input.repository === "string" ? input.repository : "unknown";

    // Scan must run inside the target repo — never report findings for one
    // repo while actually inspecting another directory.
    let scanCwd: string | undefined;
    if (resolveRepoPath) {
      const resolved = resolveRepoPath(repository);
      if (!resolved) {
        throw new Error(`No local checkout found for repository '${repository}' — cannot scan`);
      }
      scanCwd = resolved;
    }

    const prompt = buildPrompt(repository);

    const rawOutput = await runCli(command, ["--print", "--output-format", "text", prompt], scanCwd);

    const findings = parseFindings(rawOutput);
    const summaryLine = extractSummaryLine(rawOutput);

    // Persist high/medium confidence findings as proposed work_items
    const actionableFindings = findings.filter(f => f.confidence === "high" || f.confidence === "medium");
    const createdItems: Array<{ itemId: number; finding: DefectFinding }> = [];

    for (const f of actionableFindings) {
      const body = [
        f.evidence ? `Evidence: ${f.evidence}` : null,
        f.impact ? `Impact: ${f.impact}` : null,
        `Confidence: ${f.confidence}`,
        `Source: defect_scan of ${repository}`,
      ].filter(Boolean).join("\n");

      const item = ctx.db.createWorkItem({
        kind: "defect",
        source: "defect_scan",
        repository,
        title: f.title,
        body,
        created_by: "worker",
      });
      createdItems.push({ itemId: item.id, finding: f });
    }

    // Auto-triage: run a second CLI pass to approve or reject each finding
    if (autoTriage && createdItems.length > 0) {
      const triagePrompt = buildTriagePrompt(repository, actionableFindings);
      const triageOutput = await runCli(command, ["--print", "--output-format", "text", triagePrompt], scanCwd);
      const decisions = parseTriageDecisions(triageOutput);

      const notifyChatId = typeof input.notify_chat_id === "number" ? input.notify_chat_id : undefined;

      for (const decision of decisions) {
        const entry = createdItems[decision.index];
        if (!entry) continue;

        if (decision.decision === "APPROVE") {
          ctx.db.updateWorkItemStatus(entry.itemId, "approved");
          if (repository) {
            ctx.db.createWorkJob({
              task_type: "open_github_issue",
              idempotency_key: `gh_issue:${entry.itemId}`,
              work_item_id: entry.itemId,
              input_json: {
                work_item_id: entry.itemId,
                repository,
                ...(notifyChatId != null ? { notify_chat_id: notifyChatId } : {}),
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
              ...(notifyChatId != null ? { notify_chat_id: notifyChatId } : {}),
            },
          });
        } else {
          ctx.db.updateWorkItemStatus(entry.itemId, "closed");
        }
      }
    }

    const created = createdItems.length;
    const summary = created > 0
      ? `${summaryLine} — ${created} work item(s) ${autoTriage ? "auto-triaged." : "queued for review."}`
      : summaryLine;

    return { summary, rawOutput, findings, work_item_ids: createdItems.map(item => item.itemId) };
  };
}
