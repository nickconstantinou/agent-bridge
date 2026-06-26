import { describe, expect, it } from "vitest";
import { isCodeCliAllowed, resolveWorkerCliPolicy } from "../src/workerCliPolicy.js";

describe("resolveWorkerCliPolicy", () => {
  it("defaults interactive routing to all CLIs but code routing to Codex and Claude only", () => {
    expect(resolveWorkerCliPolicy({})).toEqual({
      interactiveChain: ["codex", "claude", "antigravity"],
      codeChain: ["codex", "claude"],
      scribeChain: ["antigravity", "codex", "claude"],
    });
  });

  it("derives code chain from WORKER_CLI_CHAIN while stripping antigravity", () => {
    const policy = resolveWorkerCliPolicy({
      WORKER_CLI_CHAIN: "claude,antigravity,codex",
    });

    expect(policy.interactiveChain).toEqual(["claude", "antigravity", "codex"]);
    expect(policy.codeChain).toEqual(["claude", "codex"]);
  });

  it("never allows a code chain made only of antigravity", () => {
    const policy = resolveWorkerCliPolicy({
      WORKER_CODE_CLI_CHAIN: "antigravity",
    });

    expect(policy.codeChain).toEqual(["codex", "claude"]);
  });

  it("allows a dedicated scribe chain with antigravity first", () => {
    const policy = resolveWorkerCliPolicy({
      WORKER_SCRIBE_CLI_CHAIN: "antigravity,claude",
    });

    expect(policy.scribeChain).toEqual(["antigravity", "claude"]);
  });
});

describe("isCodeCliAllowed", () => {
  it("blocks antigravity from code-writing jobs", () => {
    expect(isCodeCliAllowed("codex")).toBe(true);
    expect(isCodeCliAllowed("claude")).toBe(true);
    expect(isCodeCliAllowed("antigravity")).toBe(false);
  });
});
