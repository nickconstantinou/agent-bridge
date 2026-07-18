import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAdvisorDebugFinalPrompt } from "../src/advisorPrompt.js";
import { openDb } from "../src/db.js";
import { createOrchestratedTaskHandler } from "../src/handlers/orchestratedTask.js";

const dbPaths: string[] = [];
afterEach(() => {
  for (const path of dbPaths.splice(0)) {
    try { rmSync(path); } catch { /* already removed */ }
  }
});

describe("advisor debug provenance", () => {
  it("includes sanitised source descriptors in the final advisor prompt", () => {
    const prompt = buildAdvisorDebugFinalPrompt({
      activeProvider: "codex",
      activeModel: null,
      context: "Task context",
      hypothesis: "Parser ownership mismatch",
      missingEvidence: [],
      results: [{
        evidenceId: "ev_0123456789abcdef",
        tool: "repo.read_file",
        source: "repo.read_file path=src/parser.ts",
        status: "ok",
        summary: "Read-only evidence collected",
        content: "export const parser = canonical;",
        bytes: 32,
        truncated: false,
      }],
    });

    expect(prompt).toContain('"source":"repo.read_file path=src/parser.ts"');
  });

  it("carries structured evidence claims into the only executor retry", async () => {
    const dbPath = join(tmpdir(), `advisor-debug-provenance-${Date.now()}-${Math.random()}.sqlite`);
    dbPaths.push(dbPath);
    const db = openDb(dbPath);
    const item = db.createWorkItem({
      kind: "feature",
      source: "telegram",
      repository: "owner/repo",
      title: "Fix parser ownership",
      created_by: "worker",
    });
    const runCli = vi.fn().mockResolvedValue("Completed the bounded retry.");
    const runGit = vi.fn().mockImplementation((args: string[]) => args[0] === "diff" ? "src/parser.ts\n" : "");

    try {
      const result = await createOrchestratedTaskHandler({
        runCli,
        runGit,
        runTests: vi.fn().mockResolvedValue({ ok: true, output: "ok" }),
      })(
        { work_item_id: item.id },
        {
          db,
          workerId: "worker",
          phase: "executing_retry",
          phaseData: {
            workItemId: item.id,
            repoPath: "/tmp/repo",
            branchName: `agent/work-${item.id}`,
            plan: "Use one parser",
            debugAttempted: true,
            blockedResult: {
              status: "BLOCKED",
              reason: "NEEDS_ADVISOR",
              hypothesis: "ownership",
              attemptedSteps: ["read"],
              failingEvidence: "failure",
              relevantFiles: ["src/parser.ts"],
              decisionNeeded: "owner",
            },
            advisorDebug: {
              verdict: "retry",
              advice: "Use the canonical parser",
              evidenceIds: ["ev_0123456789abcdef"],
              evidenceBasis: [{
                claim: "src/parser.ts owns the canonical parser",
                evidenceIds: ["ev_0123456789abcdef"],
              }],
              assumptions: ["Compatibility wrapper remains public"],
              unresolvedConflicts: [],
              verificationSteps: ["Run parser tests"],
              confidence: "medium",
            },
          },
        },
      );

      expect(result).toMatchObject({ status: "continue", phase: "verifying" });
      const prompt = String(runCli.mock.calls[0][1].at(-1));
      expect(prompt).toMatch(/Evidence basis:/);
      expect(prompt).toContain("src/parser.ts owns the canonical parser [ev_0123456789abcdef]");
      expect(prompt).toContain("Compatibility wrapper remains public");
    } finally {
      db.close();
    }
  });
});
