import { describe, expect, it } from "vitest";
import {
  AgyPipeClient,
  calculateBrevityScore,
  calculateCompositeScore,
  CodexPipeClient,
  estimateTokenCount,
  extractAgyResponse,
  parseJsonObject,
  parsePromptVariant,
  renderHistoryLine,
} from "../scripts/optimize-prompt-loop.js";

describe("optimize prompt loop scoring helpers", () => {
  it("estimates tokens deterministically without external services", () => {
    expect(estimateTokenCount("Run `npm test` in src/cli.ts.")).toBe(7);
    expect(estimateTokenCount("")).toBe(0);
  });

  it("calculates brevity score from baseline and optimized completion tokens", () => {
    expect(calculateBrevityScore(50, 100)).toBe(0.5);
    expect(calculateBrevityScore(100, 100)).toBe(0);
    expect(calculateBrevityScore(150, 100)).toBe(0);
    expect(calculateBrevityScore(0, 0)).toBe(1);
  });

  it("combines brevity and quality with the required weights", () => {
    expect(calculateCompositeScore({ brevityScore: 0.25, qualityScore: 0.75 })).toBeCloseTo(0.55);
  });

  it("parses JSON objects from strict or fenced LLM output", () => {
    expect(parseJsonObject<{ score: number }>('{"score":0.82}')).toEqual({ score: 0.82 });
    expect(parseJsonObject<{ score: number }>("```json\n{\"score\":0.4}\n```")).toEqual({ score: 0.4 });
  });

  it("normalizes optimizer prompt variants with non-string changes", () => {
    expect(parsePromptVariant('{"prompt":"Telegram response style:\\n- Direct.","changes":["cut filler","keep facts"]}')).toEqual({
      prompt: "Telegram response style:\n- Direct.",
      changes: "cut filler; keep facts",
    });
  });

  it("renders the reporting line required by the spike", () => {
    const line = renderHistoryLine({
      iteration: 2,
      accepted: true,
      changes: "Removed filler allowances.",
      averageTokenReduction: 0.42,
      averageQualityScore: 0.88,
      finalCompositeScore: 0.696,
    });

    expect(line).toContain("Iteration 2");
    expect(line).toContain("Prompt Changes Made: Removed filler allowances.");
    expect(line).toContain("Average Token Reduction %: 42.0%");
    expect(line).toContain("Average Quality Score: 0.880");
    expect(line).toContain("Final Composite Score: 0.696");
    expect(line).toContain("Decision: accepted");
  });
});

describe("extractAgyResponse", () => {
  it("returns text after the last *** separator", () => {
    const stdout = "preamble\n***\nactual response\n";
    expect(extractAgyResponse(stdout)).toBe("actual response");
  });

  it("returns trimmed full text when no *** separator is present", () => {
    const stdout = "  plain output  ";
    expect(extractAgyResponse(stdout)).toBe("plain output");
  });

  it("handles multiple *** separators by taking content after the last one", () => {
    const stdout = "first\n***\nmiddle\n***\nfinal answer\n";
    expect(extractAgyResponse(stdout)).toBe("final answer");
  });
});

describe("AgyPipeClient", () => {
  it("passes the prompt via --print flag with --print-timeout, not via stdin", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const client = new AgyPipeClient({
      command: "agy-test",
      timeoutMs: 30_000,
      runner: async (command, args) => {
        calls.push({ command, args });
        return "result text";
      },
    });

    await expect(client.complete([
      { role: "system", content: "System rules" },
      { role: "user", content: "User prompt" },
    ], { model: "gemini-3.5-flash-high" })).resolves.toBe("result text");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("agy-test");
    expect(calls[0]?.args).toContain("--print-timeout");
    expect(calls[0]?.args).toContain("30s");
    const printIdx = calls[0]?.args.indexOf("--print") ?? -1;
    expect(printIdx).toBeGreaterThan(-1);
    const printValue = calls[0]?.args[printIdx + 1] ?? "";
    expect(printValue).toContain("System rules");
    expect(printValue).toContain("User prompt");
  });

  it("includes json-only instruction in the --print value when jsonMode is true", async () => {
    let capturedPrompt = "";
    const client = new AgyPipeClient({
      runner: async (_command, args) => {
        const printIdx = args.indexOf("--print");
        capturedPrompt = args[printIdx + 1] ?? "";
        return "{}";
      },
    });

    await client.complete([{ role: "user", content: "task" }], { model: "m", jsonMode: true });

    expect(capturedPrompt).toContain("Return only strict JSON");
  });

  it("does not pass a --model flag to agy", async () => {
    let capturedArgs: string[] = [];
    const client = new AgyPipeClient({
      runner: async (_command, args) => {
        capturedArgs = args;
        return "ok";
      },
    });

    await client.complete([{ role: "user", content: "task" }], { model: "gemini-3.5-flash-high" });

    expect(capturedArgs).not.toContain("--model");
  });
});

describe("CodexPipeClient", () => {
  it("pipes formatted prompts into codex exec over stdin", async () => {
    const calls: Array<{ command: string; args: string[]; stdin: string }> = [];
    const client = new CodexPipeClient({
      command: "codex-test",
      runner: async (command, args, stdin) => {
        calls.push({ command, args, stdin });
        return "ok";
      },
    });

    await expect(client.complete([
      { role: "system", content: "System rules" },
      { role: "user", content: "User prompt" },
    ], { model: "gpt-test", jsonMode: true })).resolves.toBe("ok");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("codex-test");
    expect(calls[0]?.args).toEqual([
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--model",
      "gpt-test",
      "-",
    ]);
    expect(calls[0]?.stdin).toContain("System rules");
    expect(calls[0]?.stdin).toContain("User prompt");
    expect(calls[0]?.stdin).toContain("Return only strict JSON.");
  });
});
