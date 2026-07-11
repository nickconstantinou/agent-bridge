import { describe, expect, it, vi } from "vitest";
import { runAgentAdvisorCommand } from "../src/advisorCommand.js";

const baseEnv = {
  AGENT_BRIDGE_CONTEXT_DB: "/tmp/bridge.sqlite",
  AGENT_BRIDGE_CHAT_KEY: "123:7",
  AGENT_BRIDGE_CLI_KIND: "codex",
  AGENT_BRIDGE_REPO_PATH: "/repo",
  BRIDGE_ADVISOR_ENABLED: "true",
  BRIDGE_ADVISOR_CHAIN: "claude:fable-5,codex:gpt-5.6-luna",
};

describe("agent advisor command", () => {
  it("binds a valid agent request to the current chat and turn", async () => {
    const request = vi.fn().mockResolvedValue({
      adviceMd: "Prefer the smaller boundary.",
      risks: ["Nested invocation contention"],
      suggestedNextSteps: ["Add a smoke test"],
      confidence: "high",
      provider: "claude",
      model: "fable-5",
      requestId: "generated",
    });

    const output = await runAgentAdvisorCommand(
      ["--mode", "review", "--task", "Review the proposed API"],
      baseEnv,
      { requestAdvisor: request, requestId: () => "req-1" },
    );

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        requestId: "req-1",
        scopeKey: "123:7",
        turnKey: "123:7:agent",
        origin: "manual",
        mode: "review",
        task: "Review the proposed API",
        activeProvider: "codex",
      }),
      cwd: "/repo",
    }));
    expect(output).toContain("Prefer the smaller boundary.");
    expect(output).toContain("claude:fable-5");
  });

  it.each(["plan", "review", "debug", "risk", "decision"])("accepts %s mode", async (mode) => {
    const request = vi.fn().mockResolvedValue({
      adviceMd: "Advice", risks: [], suggestedNextSteps: [], confidence: "medium",
      provider: "codex", model: "gpt-5.6-luna", requestId: "req",
    });
    await runAgentAdvisorCommand(["--mode", mode, "--task", "Task"], baseEnv, {
      requestAdvisor: request,
      requestId: () => "req",
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects invalid input before opening the provider boundary", async () => {
    const request = vi.fn();
    await expect(runAgentAdvisorCommand(["--mode", "execute", "--task", "Do it"], baseEnv, {
      requestAdvisor: request,
    })).rejects.toThrow(/invalid advisor mode/i);
    await expect(runAgentAdvisorCommand(["--mode", "review", "--task", ""], baseEnv, {
      requestAdvisor: request,
    })).rejects.toThrow(/task is required/i);
    expect(request).not.toHaveBeenCalled();
  });

  it("requires bridge-bound database and chat scope", async () => {
    await expect(runAgentAdvisorCommand(["--mode", "review", "--task", "Task"], {
      ...baseEnv,
      AGENT_BRIDGE_CHAT_KEY: undefined,
    })).rejects.toThrow(/AGENT_BRIDGE_CHAT_KEY is required/);
  });
});
