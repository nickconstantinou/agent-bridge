import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdvisorEvidenceToolBroker } from "../src/advisorEvidenceTools.js";
import { AdvisorService } from "../src/advisorService.js";
import type { AdvisorConfig } from "../src/advisorTypes.js";
import { openDb } from "../src/db.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "advisor-investigation-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("AdvisorService read-only debug investigation", () => {
  it("uses two physical model turns and one logical task budget", async () => {
    const dir = tempDir();
    const db = openDb(join(dir, "bridge.sqlite"));
    const config: AdvisorConfig = {
      enabled: true,
      mode: "manual",
      chain: [{ provider: "claude", model: "claude-fable-5" }],
      maxCallsPerTurn: 1,
      maxCallsPerTask: 1,
      timeoutMs: 5_000,
      contextMaxChars: 20_000,
    };
    const runCli = vi.fn().mockImplementation(async (_command: string, args: string[]) => {
      if (runCli.mock.calls.length === 1) {
        return JSON.stringify({
          hypothesis: "The implementation missed the current plan constraint",
          tool_requests: [{ tool: "evidence.plan" }],
          missing_evidence: [],
        });
      }
      const evidenceId = args.join(" ").match(/ev_[a-f0-9]{16}/)?.[0];
      return JSON.stringify({
        verdict: "retry",
        advice_md: "Apply the missing guard described by the plan.",
        risks: ["Preserve existing behavior"],
        suggested_next_steps: ["Change only the guarded branch"],
        verification_steps: ["Run the focused test"],
        evidence_ids: evidenceId ? [evidenceId] : [],
        assumptions: [],
        confidence: "medium",
      });
    });
    const service = new AdvisorService({
      db,
      config,
      bots: { claude: { command: "claude", modelPreference: null } },
      runCli,
    });
    const evidenceTools = new AdvisorEvidenceToolBroker({
      repoPath: dir,
      evidence: { plan: "Add the missing guard and focused test." },
    });

    try {
      const result = await service.requestTrusted({
        origin: "worker",
        scopeKey: "worker:work-item:1",
        taskKey: "work-item:1",
        mode: "debug",
        task: "Diagnose the blocked attempt",
        activeProvider: "codex",
        activeModel: null,
        cwd: dir,
        evidence: { attemptSummary: "Parser rejects the new state." },
        evidenceTools,
      });

      expect(result).toMatchObject({ verdict: "retry", confidence: "medium" });
      expect(result.evidenceIds).toHaveLength(1);
      expect(runCli).toHaveBeenCalledTimes(2);
      const attempts = db.getAdvisorAttempts(result.requestId);
      expect(attempts).toHaveLength(2);
      expect(attempts.map((attempt) => attempt.ordinal)).toEqual([1, 2]);

      await expect(service.requestTrusted({
        origin: "worker",
        scopeKey: "worker:work-item:1",
        taskKey: "work-item:1",
        mode: "debug",
        task: "Try to spend the same logical task budget again",
        activeProvider: "codex",
        activeModel: null,
        cwd: dir,
        evidenceTools: new AdvisorEvidenceToolBroker({ repoPath: dir, evidence: { plan: "same" } }),
      })).rejects.toThrow(/budget exhausted/i);
    } finally {
      db.close();
    }
  });

  it("downgrades high confidence when requested evidence is unavailable", async () => {
    const dir = tempDir();
    const db = openDb(join(dir, "bridge.sqlite"));
    const config: AdvisorConfig = {
      enabled: true,
      mode: "manual",
      chain: [{ provider: "claude", model: "claude-fable-5" }],
      maxCallsPerTurn: 2,
      maxCallsPerTask: 2,
      timeoutMs: 5_000,
      contextMaxChars: 20_000,
    };
    const runCli = vi.fn().mockImplementation(async () => {
      if (runCli.mock.calls.length === 1) {
        return JSON.stringify({ hypothesis: "Need test output", tool_requests: [{ tool: "evidence.test_failures" }], missing_evidence: [] });
      }
      return JSON.stringify({
        verdict: "insufficient_evidence",
        advice_md: "The test evidence was unavailable.",
        risks: [],
        suggested_next_steps: ["Collect the failing test output"],
        verification_steps: [],
        evidence_ids: [],
        assumptions: [],
        confidence: "high",
      });
    });
    const service = new AdvisorService({ db, config, bots: { claude: { command: "claude", modelPreference: null } }, runCli });

    try {
      const result = await service.requestTrusted({
        origin: "worker",
        scopeKey: "worker:work-item:2",
        taskKey: "work-item:2",
        mode: "debug",
        task: "Diagnose missing evidence",
        activeProvider: "codex",
        activeModel: null,
        cwd: dir,
        evidenceTools: new AdvisorEvidenceToolBroker({ repoPath: dir }),
      });
      expect(result.confidence).toBe("medium");
      expect(result.verdict).toBe("insufficient_evidence");
    } finally {
      db.close();
    }
  });
});
