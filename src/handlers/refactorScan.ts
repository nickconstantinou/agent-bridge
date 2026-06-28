/**
 * PURPOSE: Job handler for refactor_scan task type.
 * Runs a refactoring analysis of a repository via CLI and creates proposed work_items.
 * NEIGHBORS: src/jobExecutor.ts, src/index-worker.ts
 */

import type { JobHandler, JobHandlerInput, JobHandlerContext } from "../jobExecutor.js";
import { resolveLocalRepoPath } from "../workspace.js";

type RunCli = (command: string, args: string[], cwd?: string) => Promise<string>;

interface RefactorScanDeps {
  runCli: RunCli;
  command?: string;
  resolveRepoPath?: (repository: string) => string | null;
}

function buildPrompt(repository: string): string {
  return `You are performing a read-only refactoring analysis of the repository: ${repository}.

Your task:
1. Examine the repository structure, key source files, and TypeScript/JS patterns.
2. Identify up to 5 concrete refactoring opportunities: dead code, duplicated logic, oversized files, unclear boundaries, or naming that harms readability.
3. For each finding output a JSON object on its own line: {"title": "...", "rationale": "...", "files": ["..."]}

Output only the JSON lines. No markdown, no prose.`;
}

interface RefactorFinding {
  title: string;
  rationale?: string;
  files?: string[];
}

function parseFindings(output: string): RefactorFinding[] {
  return output
    .split("\n")
    .filter(l => l.trim().startsWith("{"))
    .map(l => { try { return JSON.parse(l) as RefactorFinding; } catch { return null; } })
    .filter((f): f is RefactorFinding => f !== null && typeof f.title === "string");
}

export function createRefactorScanHandler(deps: RefactorScanDeps): JobHandler {
  const { runCli, command = "claude", resolveRepoPath = resolveLocalRepoPath } = deps;

  return async function refactorScanHandler(input: JobHandlerInput, ctx: JobHandlerContext) {
    const repository = typeof input.repository === "string" ? input.repository : null;
    if (!repository) throw new Error("input.repository is required");

    const repoPath = resolveRepoPath(repository);
    const cwd = repoPath ?? process.cwd();

    const prompt = buildPrompt(repository);
    const output = await runCli(command, ["-p", prompt], cwd);

    const findings = parseFindings(output);
    for (const f of findings) {
      ctx.db.createWorkItem({
        kind: "refactor",
        source: "refactor_scan",
        title: f.title,
        created_by: "worker",
        body: [f.rationale, f.files?.join(", ")].filter(Boolean).join("\n"),
        repository,
        priority: "medium",
      });
    }

    return {
      summary: findings.length > 0
        ? `Refactor scan of **${repository}** found ${findings.length} opportunit${findings.length !== 1 ? "ies" : "y"}.`
        : `Refactor scan of **${repository}** found no refactoring opportunities.`,
    };
  };
}
