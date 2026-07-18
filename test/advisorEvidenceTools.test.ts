import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdvisorEvidenceToolBroker,
  parseAdvisorEvidenceToolRequest,
} from "../src/advisorEvidenceTools.js";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const gitReadPrefix = ["--no-pager", "-c", "core.fsmonitor=false", "-c", "credential.helper="];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("AdvisorEvidenceToolBroker", () => {
  it("collects bounded repository and worker evidence with stable identifiers", async () => {
    const repo = tempDir("advisor-evidence-");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "service.ts"), "export const state = 'blocked';\n");
    const audit = vi.fn();
    const broker = new AdvisorEvidenceToolBroker({
      repoPath: repo,
      evidence: { plan: "Inspect service.ts", acceptance: "State becomes ready" },
      audit,
    });

    const results = await broker.execute([
      { tool: "repo.list_files", path: ".", depth: 2 },
      { tool: "repo.read_file", path: "src/service.ts" },
      { tool: "repo.search_text", path: "src", query: "blocked" },
      { tool: "evidence.plan" },
    ]);

    expect(results.every((result) => result.status === "ok")).toBe(true);
    expect(results.every((result) => result.truncated === false)).toBe(true);
    expect(results[0].content).toContain("src/service.ts");
    expect(results[1].content).toContain("state");
    expect(results[2].content).toContain("src/service.ts:1");
    expect(results[3].content).toBe("Inspect service.ts");
    expect(results.every((result) => /^ev_[a-f0-9]{16}$/.test(result.evidenceId))).toBe(true);
    expect(audit).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(audit.mock.calls)).not.toContain("Inspect service.ts");
  });

  it("uses only isolated fixed Git argument shapes", async () => {
    const repo = tempDir("advisor-git-");
    const runGit = vi.fn().mockResolvedValue("git evidence");
    const broker = new AdvisorEvidenceToolBroker({ repoPath: repo, runGit });

    const results = await broker.execute([
      { tool: "git.status" },
      { tool: "git.diff", scope: "staged" },
      { tool: "git.diff", scope: "base_to_head", base: "main", head: "feature/test" },
      { tool: "git.show", object: "HEAD", path: "src/file.ts" },
      { tool: "git.log", count: 4 },
    ]);

    expect(results.every((result) => result.status === "ok")).toBe(true);
    expect(runGit.mock.calls).toEqual([
      [[...gitReadPrefix, "status", "--short", "--branch", "--untracked-files=normal"], repo],
      [[...gitReadPrefix, "diff", "--cached", "--no-ext-diff", "--no-textconv", "--unified=3"], repo],
      [[...gitReadPrefix, "diff", "--no-ext-diff", "--no-textconv", "--unified=3", "main...feature/test"], repo],
      [[...gitReadPrefix, "show", "--no-ext-diff", "--no-textconv", "HEAD:src/file.ts"], repo],
      [[...gitReadPrefix, "log", "-4", "--date=iso-strict", "--pretty=format:%H%x09%ad%x09%s"], repo],
    ]);
  });

  it("fails closed on traversal, sensitive files, Git internals, symlinks, and binary content", async () => {
    const repo = tempDir("advisor-deny-");
    const outside = tempDir("advisor-outside-");
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, ".git", "config"), "[credential]\nhelper=unsafe\n");
    writeFileSync(join(repo, ".env.shared"), "API_KEY=secret\n");
    writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 1, 2]));
    writeFileSync(join(outside, "outside.ts"), "export const escaped = true;\n");
    symlinkSync(join(outside, "outside.ts"), join(repo, "escape.ts"));
    const broker = new AdvisorEvidenceToolBroker({ repoPath: repo });

    const results = await broker.execute([
      { tool: "repo.read_file", path: "../outside.ts" } as never,
      { tool: "repo.read_file", path: ".env.shared" },
      { tool: "repo.read_file", path: ".git/config" },
      { tool: "repo.read_file", path: "escape.ts" },
      { tool: "repo.read_file", path: "binary.bin" },
    ]);

    expect(results.map((result) => result.status)).toEqual(["denied", "denied", "denied", "denied", "denied"]);
    expect(results.every((result) => result.content === "")).toBe(true);
  });

  it("enforces call and aggregate byte budgets and marks truncation explicitly", async () => {
    const repo = tempDir("advisor-limits-");
    writeFileSync(join(repo, "large.txt"), "x".repeat(200));
    const tooMany = new AdvisorEvidenceToolBroker({
      repoPath: repo,
      limits: { maxCalls: 2, maxResultBytes: 20, maxAggregateBytes: 25 },
    });

    await expect(tooMany.execute([
      { tool: "repo.read_file", path: "large.txt" },
      { tool: "repo.read_file", path: "large.txt" },
      { tool: "repo.read_file", path: "large.txt" },
    ])).rejects.toThrow(/tool limit exceeded/i);

    const broker = new AdvisorEvidenceToolBroker({
      repoPath: repo,
      limits: { maxCalls: 2, maxResultBytes: 20, maxAggregateBytes: 25 },
    });
    const results = await broker.execute([
      { tool: "repo.read_file", path: "large.txt" },
      { tool: "repo.read_file", path: "large.txt" },
    ]);
    expect(results[0].bytes).toBeLessThanOrEqual(20);
    expect(results[0].truncated).toBe(true);
    expect(results[0].summary).toMatch(/truncated/i);
    expect(results[0].bytes + results[1].bytes).toBeLessThanOrEqual(25);
    expect(results[1].truncated).toBe(true);
  });

  it("validates model-selected tool requests before execution", () => {
    expect(parseAdvisorEvidenceToolRequest({ tool: "git.log", count: 999 })).toEqual({ tool: "git.log", count: 20 });
    expect(() => parseAdvisorEvidenceToolRequest({ tool: "repo.read_file", path: "../../etc/passwd" })).toThrow(/escapes/i);
    expect(() => parseAdvisorEvidenceToolRequest({ tool: "repo.read_file", path: ".git/HEAD" })).toThrow(/sensitive/i);
    expect(() => parseAdvisorEvidenceToolRequest({ tool: "git.show", object: "--exec=bad" })).toThrow(/supported Git object/i);
    expect(() => parseAdvisorEvidenceToolRequest({ tool: "git.show", object: "HEAD", path: "src:a.ts" })).toThrow(/not supported/i);
    expect(() => parseAdvisorEvidenceToolRequest({ tool: "shell", command: "cat /etc/passwd" })).toThrow(/unsupported/i);
  });
});
