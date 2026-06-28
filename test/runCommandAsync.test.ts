/**
 * Tests for the async command runner used by job handler wiring.
 * Replaces the execFileSync wiring that blocked the Telegram polling loop
 * for the duration of git/gh/npm child processes.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRunCommand } from "../src/runCommandAsync.js";

describe("createRunCommand", () => {
  it("resolves with trimmed stdout", async () => {
    const run = createRunCommand();
    const out = await run("echo", ["hello world"]);
    expect(out).toBe("hello world");
  });

  it("rejects with stderr content when the command fails", async () => {
    const run = createRunCommand();
    await expect(
      run("node", ["-e", "console.error('boom'); process.exit(3)"]),
    ).rejects.toThrow(/boom/);
  });

  it("does not block the event loop while the command runs", async () => {
    const run = createRunCommand();
    let timerFired = false;
    const timer = new Promise<void>((res) => setTimeout(() => { timerFired = true; res(); }, 50));

    const cmd = run("node", ["-e", "setTimeout(() => {}, 300)"]);
    await timer; // must fire while the child is still running
    expect(timerFired).toBe(true);
    await cmd;
  });

  it("loads GH_TOKEN from GITHUB_TOKEN_FILE when loadGhToken is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ghtoken-"));
    const tokenPath = join(dir, "token.txt");
    writeFileSync(tokenPath, "tok-secret-123\n");
    const prevEnv = process.env.GITHUB_TOKEN_FILE;
    process.env.GITHUB_TOKEN_FILE = tokenPath;

    try {
      const run = createRunCommand({ loadGhToken: true });
      const out = await run("node", ["-e", "console.log(process.env.GH_TOKEN)"]);
      expect(out).toBe("tok-secret-123");
    } finally {
      if (prevEnv === undefined) delete process.env.GITHUB_TOKEN_FILE;
      else process.env.GITHUB_TOKEN_FILE = prevEnv;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports a working directory option", async () => {
    const run = createRunCommand();
    const out = await run("pwd", [], { cwd: tmpdir() });
    expect(out).toBe(tmpdir());
  });

  it("supports per-command env overrides", async () => {
    const run = createRunCommand();
    const out = await run("node", ["-e", "console.log(process.env.WORKER_DEFAULT_REPO || '')"], {
      env: { ...process.env, WORKER_DEFAULT_REPO: "" },
    });
    expect(out).toBe("");
  });
});
