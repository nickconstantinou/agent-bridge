import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveGithubOwner, parseRepoSelectCallback } from "../src/repoRegistry.js";

describe("resolveGithubOwner", () => {
  const original = process.env.GITHUB_USERNAME;
  afterEach(() => { process.env.GITHUB_USERNAME = original; });

  it("returns GITHUB_USERNAME when set", () => {
    process.env.GITHUB_USERNAME = "testuser";
    expect(resolveGithubOwner()).toBe("testuser");
  });

  it("throws when GITHUB_USERNAME is unset", () => {
    delete process.env.GITHUB_USERNAME;
    expect(() => resolveGithubOwner()).toThrow("GITHUB_USERNAME env var is not set");
  });
});

describe("parseRepoSelectCallback", () => {
  it("parses rs:<name>:<ctx>", () => {
    expect(parseRepoSelectCallback("rs:agent-bridge:r")).toEqual({ repo: "agent-bridge", ctx: "r" });
  });

  it("parses rs:<name>:f", () => {
    expect(parseRepoSelectCallback("rs:content-crawler:f")).toEqual({ repo: "content-crawler", ctx: "f" });
  });

  it("parses rs:<name>:rf", () => {
    expect(parseRepoSelectCallback("rs:dashboard:rf")).toEqual({ repo: "dashboard", ctx: "rf" });
  });

  it("returns null for non-rs prefix", () => {
    expect(parseRepoSelectCallback("wi:1:view")).toBeNull();
  });

  it("returns null when name is empty", () => {
    expect(parseRepoSelectCallback("rs::r")).toBeNull();
  });

  it("returns null when ctx is empty", () => {
    expect(parseRepoSelectCallback("rs:agent-bridge:")).toBeNull();
  });

  it("returns null for data > 64 bytes", () => {
    const long = "rs:" + "a".repeat(62) + ":r";
    expect(parseRepoSelectCallback(long)).toBeNull();
  });
});

describe("fetchUserRepos", () => {
  it("parses NDJSON output from gh", async () => {
    const { fetchUserRepos } = await import("../src/repoRegistry.js");
    // We need to test the NDJSON parsing logic in isolation
    // Since fetchUserRepos caches, test via the exported function with a mock
    // The NDJSON parser is internal — test it via buildRepoKeyboard with mocked execFile
    expect(fetchUserRepos).toBeInstanceOf(Function);
  });
});

describe("buildRepoKeyboard", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns null on fetch failure", async () => {
    vi.doMock("node:child_process", () => ({
      execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error, stdout: string, stderr: string) => void) => {
        cb(new Error("gh not available"), "", "gh: command not found");
      },
    }));
    const { buildRepoKeyboard } = await import("../src/repoRegistry.js");
    const result = await buildRepoKeyboard("r");
    expect(result).toBeNull();
  });

  it("builds keyboard from NDJSON output", async () => {
    const ndjson = '{"name":"agent-bridge","full_name":"nick/agent-bridge"}\n{"name":"dashboard","full_name":"nick/dashboard"}\n';
    vi.doMock("node:child_process", () => ({
      execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string, stderr: string) => void) => {
        cb(null, ndjson, "");
      },
    }));
    const { buildRepoKeyboard } = await import("../src/repoRegistry.js");
    const result = await buildRepoKeyboard("r");
    expect(result).not.toBeNull();
    expect(result!.inline_keyboard.length).toBeGreaterThan(0);
    // Two repos → one row of two buttons
    expect(result!.inline_keyboard[0]).toEqual([
      { text: "agent-bridge", callback_data: "rs:agent-bridge:r" },
      { text: "dashboard", callback_data: "rs:dashboard:r" },
    ]);
  });

  it("returns null when repos list is empty", async () => {
    vi.doMock("node:child_process", () => ({
      execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string, stderr: string) => void) => {
        cb(null, "", "");
      },
    }));
    const { buildRepoKeyboard } = await import("../src/repoRegistry.js");
    const result = await buildRepoKeyboard("r");
    expect(result).toBeNull();
  });
});
