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

export function createDefectScanHandler(deps: DefectScanDeps): JobHandler {
  const { runCli, command = "claude", resolveRepoPath } = deps;

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
    for (const f of findings) {
      if (f.confidence === "high" || f.confidence === "medium") {
        const body = [
          f.evidence ? `Evidence: ${f.evidence}` : null,
          f.impact ? `Impact: ${f.impact}` : null,
          `Confidence: ${f.confidence}`,
          `Source: defect_scan of ${repository}`,
        ].filter(Boolean).join("\n");

        ctx.db.createWorkItem({
          kind: "defect",
          source: "defect_scan",
          repository,
          title: f.title,
          body,
          created_by: "worker",
        });
      }
    }

    const created = findings.filter(f => f.confidence === "high" || f.confidence === "medium").length;
    const summary = created > 0
      ? `${summaryLine} — ${created} work item(s) queued for review.`
      : summaryLine;

    return { summary, rawOutput, findings };
  };
}
