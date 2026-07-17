import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCliInvocation, parseCliResult, isCapacityExhaustedError } from "../src/cli.js";

function withTempImage(fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "agent-bridge-fixture-attachment-"));
  const path = join(dir, "a.png");
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #135 Phase 3A — characterization fixtures.
//
// This file locks in buildCliInvocation()/parseCliResult()'s current
// per-provider behaviour across the dimensions the Phase 3 plan calls out
// (invocation snapshots per provider/mode, tool-free flags, attachment/stdin
// contracts, trusted/safe flags, session resume/fresh-session rules, stream-
// json handling, malformed/legacy output parsing, and fallback
// classification) BEFORE any provider branch is moved out of src/cli.ts in
// PR 3B/3C. A behavioural difference introduced by that later move must show
// up here first.

describe("provider invocation fixtures — codex", () => {
  it("fresh session, safe mode, no model", () => {
    const inv = buildCliInvocation({ bot: "codex", prompt: "hi", sessionId: null, command: "codex" });
    expect(inv.command).toBe("codex");
    expect(inv.args[0]).toBe("exec");
    expect(inv.args).not.toContain("resume");
    expect(inv.args).toContain("--skip-git-repo-check");
    expect(inv.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("resumes an existing session when sessionId is set and there are no attachments", () => {
    const inv = buildCliInvocation({ bot: "codex", prompt: "hi", sessionId: "sess-1", command: "codex" });
    expect(inv.args.slice(0, 3)).toEqual(["exec", "resume", "sess-1"]);
  });

  it("forces a fresh session when attachments are present even with a sessionId", () => {
    const inv = buildCliInvocation({
      bot: "codex", prompt: "hi", sessionId: "sess-1", command: "codex", attachments: ["/tmp/a.png"],
    });
    expect(inv.args[0]).toBe("exec");
    expect(inv.args).not.toContain("resume");
    expect(inv.args).toContain("-i");
    expect(inv.args[inv.args.indexOf("-i") + 1]).toBe("/tmp/a.png");
    expect(inv.args.slice(-2)).toEqual(["--", "-"]);
    expect(inv.stdin).toBeTruthy();
  });

  it("trusted mode adds the approvals/sandbox bypass flag", () => {
    const inv = buildCliInvocation({ bot: "codex", prompt: "hi", sessionId: null, command: "codex", executionMode: "trusted" });
    expect(inv.args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("tool-free mode disables the documented Codex tool set", () => {
    const inv = buildCliInvocation({ bot: "codex", prompt: "hi", sessionId: null, command: "codex", toolMode: "none" });
    expect(inv.args).toEqual(expect.arrayContaining([
      "--disable", "shell_tool",
      "--disable", "browser_use",
      "--disable", "computer_use",
      "--disable", "plugins",
      "--disable", "guardian_approval",
      "--disable", "hooks",
      "--disable", "goals",
      "--disable", "apps",
    ]));
  });

  it("json output format adds --json", () => {
    const inv = buildCliInvocation({ bot: "codex", prompt: "hi", sessionId: null, command: "codex", outputFormat: "json" });
    expect(inv.args).toContain("--json");
  });
});

describe("provider invocation fixtures — claude", () => {
  it("fresh session, safe mode: --print, plugin settings, prompt as last arg", () => {
    const inv = buildCliInvocation({ bot: "claude", prompt: "hi", sessionId: null, command: "claude" });
    expect(inv.args[0]).toBe("--print");
    expect(inv.args).toContain("--settings");
    const settingsJson = inv.args[inv.args.indexOf("--settings") + 1];
    expect(JSON.parse(settingsJson)).toEqual({ enabledPlugins: { "telegram@claude-plugins-official": false } });
    expect(inv.args).not.toContain("--resume");
    expect(inv.stdin).toBeUndefined();
  });

  it("resumes an existing session with --resume", () => {
    const inv = buildCliInvocation({ bot: "claude", prompt: "hi", sessionId: "sess-9", command: "claude" });
    expect(inv.args).toContain("--resume");
    expect(inv.args[inv.args.indexOf("--resume") + 1]).toBe("sess-9");
  });

  it("trusted mode adds --dangerously-skip-permissions", () => {
    const inv = buildCliInvocation({ bot: "claude", prompt: "hi", sessionId: null, command: "claude", executionMode: "trusted" });
    expect(inv.args).toContain("--dangerously-skip-permissions");
  });

  it("tool-free mode disables tools and slash commands with a strict empty MCP config", () => {
    const inv = buildCliInvocation({ bot: "claude", prompt: "hi", sessionId: null, command: "claude", toolMode: "none" });
    expect(inv.args).toEqual(expect.arrayContaining(["--tools", "", "--disable-slash-commands", "--strict-mcp-config"]));
    expect(inv.args[inv.args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
  });

  it("attachments switch to the stream-json stdin contract with base64 images, not a trailing prompt arg", () => {
    withTempImage((path) => {
      const inv = buildCliInvocation({
        bot: "claude", prompt: "hi", sessionId: "sess-1", command: "claude", attachments: [path],
      });
      expect(inv.args).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]));
      expect(inv.args).toContain("--resume");
      expect(inv.stdin).toBeTruthy();
      expect(inv.args).not.toContain("hi");
    });
  });

  it("json output format uses --output-format json (not the stream-json attachment contract)", () => {
    const inv = buildCliInvocation({ bot: "claude", prompt: "hi", sessionId: null, command: "claude", outputFormat: "json" });
    expect(inv.args).toEqual(expect.arrayContaining(["--output-format", "json"]));
  });
});

describe("provider invocation fixtures — antigravity", () => {
  it("fresh session: no --conversation flag, includes --print-timeout and the prompt on --print", () => {
    const inv = buildCliInvocation({ bot: "antigravity", prompt: "hi", sessionId: null, command: "agy" });
    expect(inv.args).not.toContain("--conversation");
    expect(inv.args).toContain("--print-timeout");
    expect(inv.args[inv.args.length - 2]).toBe("--print");
  });

  it("resumes an existing conversation with --conversation", () => {
    const inv = buildCliInvocation({ bot: "antigravity", prompt: "hi", sessionId: "conv-1", command: "agy" });
    expect(inv.args).toContain("--conversation");
    expect(inv.args[inv.args.indexOf("--conversation") + 1]).toBe("conv-1");
  });

  it("trusted mode adds --dangerously-skip-permissions", () => {
    const inv = buildCliInvocation({ bot: "antigravity", prompt: "hi", sessionId: null, command: "agy", executionMode: "trusted" });
    expect(inv.args).toContain("--dangerously-skip-permissions");
  });

  it("tool-free mode adds --sandbox", () => {
    const inv = buildCliInvocation({ bot: "antigravity", prompt: "hi", sessionId: null, command: "agy", toolMode: "none" });
    expect(inv.args).toContain("--sandbox");
  });

  it("attachments are annotated inline into the prompt text, not passed as separate flags", () => {
    const inv = buildCliInvocation({
      bot: "antigravity", prompt: "hi", sessionId: null, command: "agy", attachments: ["/tmp/a.png"],
    });
    const promptArg = inv.args[inv.args.length - 1];
    expect(promptArg).toContain("/tmp/a.png");
    expect(inv.stdin).toBeUndefined();
  });
});

describe("provider invocation fixtures — kimchi", () => {
  it("fresh session uses --no-session", () => {
    const inv = buildCliInvocation({ bot: "kimchi", prompt: "hi", sessionId: null, command: "kimchi" });
    expect(inv.args).toContain("--no-session");
    expect(inv.args).not.toContain("--resume");
  });

  it("resumes an existing session with --resume", () => {
    const inv = buildCliInvocation({ bot: "kimchi", prompt: "hi", sessionId: "kim-1", command: "kimchi" });
    expect(inv.args).toContain("--resume");
    expect(inv.args[inv.args.indexOf("--resume") + 1]).toBe("kim-1");
    expect(inv.args).not.toContain("--no-session");
  });

  it("trusted mode maps to --yolo", () => {
    const inv = buildCliInvocation({ bot: "kimchi", prompt: "hi", sessionId: null, command: "kimchi", executionMode: "trusted" });
    expect(inv.args).toContain("--yolo");
  });

  it("tool-free mode is not supported for kimchi", () => {
    expect(() => buildCliInvocation({ bot: "kimchi", prompt: "hi", sessionId: null, command: "kimchi", toolMode: "none" }))
      .toThrow(/tool-free mode.*kimchi/i);
  });

  it("attachments are annotated inline into the prompt text (no native attachment support)", () => {
    const inv = buildCliInvocation({
      bot: "kimchi", prompt: "hi", sessionId: null, command: "kimchi", attachments: ["/tmp/a.png"],
    });
    const promptArg = inv.args[inv.args.length - 1];
    expect(promptArg).toContain("/tmp/a.png");
  });
});

describe("provider result parsing fixtures", () => {
  it("codex: extracts sessionId from thread.started and text from response.completed", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({ type: "response.completed", output_text: "done" }),
    ].join("\n");
    const result = parseCliResult({ bot: "codex", stdout });
    expect(result.sessionId).toBe("t-1");
    expect(result.text).toBe("done");
  });

  it("codex: malformed/non-JSON lines are skipped without throwing", () => {
    const stdout = "not json\n{\"broken\n" + JSON.stringify({ type: "response.completed", output_text: "ok" });
    expect(() => parseCliResult({ bot: "codex", stdout })).not.toThrow();
    expect(parseCliResult({ bot: "codex", stdout }).text).toBe("ok");
  });

  it("claude: parses the last JSON object with a result field", () => {
    const stdout = `noise\n${JSON.stringify({ type: "result", subtype: "success", session_id: "s-1", result: "hello" })}`;
    const result = parseCliResult({ bot: "claude", stdout });
    expect(result.sessionId).toBe("s-1");
    expect(result.text).toBe("hello");
  });

  it("claude: falls back to plain text when no JSON result object is present", () => {
    const result = parseCliResult({ bot: "claude", stdout: "plain response, no JSON here" });
    expect(result.text).toBe("plain response, no JSON here");
    expect(result.sessionId).toBeNull();
  });

  it("kimchi: parses plain stdout as text with no session id from stdout alone", () => {
    const result = parseCliResult({ bot: "kimchi", stdout: "kimchi says hi" });
    expect(result.text).toBe("kimchi says hi");
  });

  it("unknown bot type throws", () => {
    expect(() => parseCliResult({ bot: "unknown-bot", stdout: "x" })).toThrow(/Unknown bot type/);
  });
});

describe("provider failure fallback classification fixtures", () => {
  it("codex capacity exhaustion is fallback-eligible", () => {
    expect(isCapacityExhaustedError(new Error("CLI exited with code 1: MODEL_CAPACITY_EXHAUSTED"))).toBe(true);
  });

  it("claude rate-limit style errors are fallback-eligible", () => {
    expect(isCapacityExhaustedError(new Error(
      `CLI exited with code 1: ${JSON.stringify({ type: "result", is_error: true, api_error_status: 429, result: "rate limited" })}`,
    ))).toBe(true);
  });

  it("a generic non-capacity CLI failure is not fallback-eligible", () => {
    expect(isCapacityExhaustedError(new Error("CLI exited with code 1: command not found: kimchi"))).toBe(false);
  });
});
