import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdvisorBroker } from "../src/advisorBroker.js";
import { parseAdvisorConfig } from "../src/advisorConfig.js";
import { AdvisorService } from "../src/advisorService.js";
import { openDb } from "../src/db.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(chain = "claude:claude-fable-5,claude:claude-opus-4-8") {
  const db = openDb(":memory:");
  const runCli = vi.fn().mockResolvedValue(JSON.stringify({
    advice_md: "Unified advice.", risks: ["One risk"], suggested_next_steps: ["Next"], confidence: "high",
  }));
  const service = new AdvisorService({
    db,
    config: parseAdvisorConfig({ BRIDGE_ADVISOR_ENABLED: "true", BRIDGE_ADVISOR_CHAIN: chain }),
    bots: { claude: { command: "/trusted/claude", modelPreference: [] } },
    runCli,
  });
  return { db, runCli, service };
}

describe("unified advisor service", () => {
  it("executes manual requests tool-free through the shared execution path", async () => {
    const { db, runCli, service } = setup();
    const result = await service.requestTrusted({
      origin: "manual", scopeKey: "chat:1", turnKey: "turn-1", mode: "review", task: "Review it",
      activeProvider: "codex", activeModel: null, cwd: "/repo",
    });
    expect(result.adviceMd).toBe("Unified advice.");
    expect(runCli).toHaveBeenCalledWith(
      "/trusted/claude",
      expect.arrayContaining(["--tools", ""]),
      "/repo",
      expect.objectContaining({ advisorChild: true }),
    );
    db.close();
  });

  it("executes worker checkpoint requests through the same tool-free path", async () => {
    const { db, runCli, service } = setup();
    await service.requestTrusted({
      origin: "worker", scopeKey: "worker:task-9", taskKey: "task-9", mode: "plan", task: "Plan it",
      activeProvider: "codex", activeModel: null, cwd: "/worker/repo",
      evidence: { diffSummary: "diff", testOutput: "tests" },
    });
    expect(runCli).toHaveBeenCalledWith(
      "/trusted/claude",
      expect.arrayContaining(["--tools", ""]),
      "/worker/repo",
      expect.objectContaining({ advisorChild: true }),
    );
    const call = db.raw.prepare("SELECT scope_key, task_key, trigger FROM advisor_calls").get() as any;
    expect(call).toMatchObject({ scope_key: "worker:task-9", task_key: "task-9", trigger: "worker" });
    db.close();
  });

  it("sanitises the shared envelope and constrains unsupported high confidence", async () => {
    const { db, runCli, service } = setup();
    const result = await service.requestTrusted({
      origin: "manual", scopeKey: "chat:envelope", turnKey: "turn-envelope", mode: "review", task: "Review current evidence",
      activeProvider: "codex", activeModel: null, cwd: "/repo",
      evidence: {
        envelope: {
          assessmentGoal: "Review current state",
          currentState: [{ id: "state-1", claim: "token=do-not-forward", source: "fixture", observedAt: "2026-07-20T10:00:00Z", authority: "deterministic" }],
          acceptedDecisions: [], completedActions: [], unresolvedRisks: [], unavailableEvidence: ["current health"],
          explicitQuestion: "Is the gate safe?",
        },
      },
    });

    expect(result.confidence).toBe("medium");
    const prompt = runCli.mock.calls[0]?.[1] as string[];
    expect(prompt.join(" ")).not.toContain("do-not-forward");
    expect(prompt.join(" ")).toContain("[REDACTED]");
    db.close();
  });

  it("rejects chains containing providers without tool-free mode before consuming budget", async () => {
    const { db, runCli, service } = setup("claude:claude-fable-5,kimchi:some-model");
    await expect(service.requestTrusted({
      origin: "manual", scopeKey: "chat:1", turnKey: "turn-1", mode: "review", task: "Review it",
      activeProvider: "codex", activeModel: null, cwd: "/repo",
    })).rejects.toThrow(/tool-free/i);
    expect(runCli).not.toHaveBeenCalled();
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM advisor_calls").get()).toMatchObject({ n: 0 });
    db.close();
  });

  it("broker capability requests resolve into the same trusted execution in-process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "advisor-service-"));
    dirs.push(dir);
    const db = openDb(join(dir, "bridge.sqlite"));
    const runCli = vi.fn().mockResolvedValue(JSON.stringify({
      advice_md: "Broker advice.", risks: [], suggested_next_steps: [], confidence: "medium",
    }));
    const broker = new AdvisorBroker({
      db,
      config: parseAdvisorConfig({
        BRIDGE_ADVISOR_ENABLED: "true",
        BRIDGE_ADVISOR_CHAIN: "claude:claude-fable-5,claude:claude-opus-4-8",
      }),
      bots: { claude: { command: "/trusted/claude", modelPreference: [] } },
      runCli,
      socketDir: dir,
    });
    const capability = broker.issue({
      chatKey: "chat:7", cliKind: "codex", turnKey: "turn-1", taskKey: "task-1",
      repoPath: "/trusted/repo", activeModel: null,
    });

    const output = await broker.requestWithCapability({ capability, mode: "review", task: "Review it" });

    expect(output).toContain("Broker advice.");
    expect(runCli).toHaveBeenCalledWith(
      "/trusted/claude",
      expect.arrayContaining(["--tools", ""]),
      "/trusted/repo",
      expect.objectContaining({ advisorChild: true }),
    );
    const call = db.raw.prepare("SELECT scope_key, turn_key, task_key FROM advisor_calls").get() as any;
    expect(call).toMatchObject({ scope_key: "chat:7", turn_key: "turn-1", task_key: "task-1" });
    await broker.close();
    db.close();
  });
});
