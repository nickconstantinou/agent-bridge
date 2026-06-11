/**
 * Tests for per-job git workspaces. TDD jobs must never operate on the live
 * checkout the worker runs from — each job gets a disposable clone whose
 * origin points at the source repo's real remote.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { resolveLocalRepoPath, prepareWorkspace, createWorkspaceCleanup } from "../src/workspace.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Create a source repo with one commit and a fake GitHub origin. */
function makeSourceRepo(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@test"], dir);
  git(["config", "user.name", "test"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "init"], dir);
  git(["remote", "add", "origin", "git@github.com:owner/" + name + ".git"], dir);
  return dir;
}

describe("resolveLocalRepoPath", () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ws-root-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("resolves a bare repo name to a git checkout under the repo root", () => {
    makeSourceRepo(root, "agent-bridge");
    expect(resolveLocalRepoPath("agent-bridge", root)).toBe(join(root, "agent-bridge"));
  });

  it("resolves owner/repo form by repo name", () => {
    makeSourceRepo(root, "agent-bridge");
    expect(resolveLocalRepoPath("owner/agent-bridge", root)).toBe(join(root, "agent-bridge"));
  });

  it("returns null when no checkout exists", () => {
    expect(resolveLocalRepoPath("nope", root)).toBeNull();
  });

  it("returns null when the directory exists but is not a git repo", () => {
    mkdirSync(join(root, "plain-dir"));
    expect(resolveLocalRepoPath("plain-dir", root)).toBeNull();
  });
});

describe("prepareWorkspace", () => {
  let root: string;
  let baseDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ws-root-"));
    baseDir = mkdtempSync(join(tmpdir(), "ws-base-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("clones the source repo into baseDir/work-<id>", async () => {
    makeSourceRepo(root, "agent-bridge");
    const dir = await prepareWorkspace({ repository: "agent-bridge", workItemId: 7, repoRoot: root, baseDir });

    expect(dir).toBe(join(baseDir, "work-7"));
    expect(existsSync(join(dir, "README.md"))).toBe(true);
    expect(existsSync(join(dir, ".git"))).toBe(true);
  });

  it("points the clone's origin at the source repo's real remote", async () => {
    makeSourceRepo(root, "agent-bridge");
    const dir = await prepareWorkspace({ repository: "agent-bridge", workItemId: 8, repoRoot: root, baseDir });

    const origin = git(["remote", "get-url", "origin"], dir).trim();
    expect(origin).toBe("git@github.com:owner/agent-bridge.git");
  });

  it("replaces a stale workspace from a previous attempt", async () => {
    makeSourceRepo(root, "agent-bridge");
    const stale = join(baseDir, "work-9");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "leftover.txt"), "debris");

    const dir = await prepareWorkspace({ repository: "agent-bridge", workItemId: 9, repoRoot: root, baseDir });
    expect(existsSync(join(dir, "leftover.txt"))).toBe(false);
    expect(existsSync(join(dir, "README.md"))).toBe(true);
  });

  it("throws a clear error when no local checkout exists for the repository", async () => {
    await expect(
      prepareWorkspace({ repository: "ghost-repo", workItemId: 10, repoRoot: root, baseDir }),
    ).rejects.toThrow(/no local checkout|ghost-repo/i);
  });
});

describe("createWorkspaceCleanup", () => {
  let baseDir: string;

  beforeEach(() => { baseDir = mkdtempSync(join(tmpdir(), "ws-base-")); });
  afterEach(() => { rmSync(baseDir, { recursive: true, force: true }); });

  it("removes a workspace directory under baseDir", () => {
    const cleanup = createWorkspaceCleanup(baseDir);
    const dir = join(baseDir, "work-3");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "f.txt"), "x");

    cleanup(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("refuses to delete paths outside baseDir", () => {
    const cleanup = createWorkspaceCleanup(baseDir);
    const outside = mkdtempSync(join(tmpdir(), "ws-outside-"));
    try {
      cleanup(outside);
      // Must be a no-op, not a deletion
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("prepareWorkspace dependency install", () => {
  let root: string;
  let baseDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ws-root-"));
    baseDir = mkdtempSync(join(tmpdir(), "ws-base-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("runs installDeps in the clone when package.json exists", async () => {
    const dir = makeSourceRepo(root, "node-repo");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "true" } }));
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "add package.json"], dir);

    const calls: string[] = [];
    const ws = await prepareWorkspace({
      repository: "node-repo", workItemId: 21, repoRoot: root, baseDir,
      installDeps: (d) => { calls.push(d); },
    });

    expect(calls).toEqual([ws]);
  });

  it("skips installDeps when the repo has no package.json", async () => {
    makeSourceRepo(root, "plain-repo");
    const calls: string[] = [];
    await prepareWorkspace({
      repository: "plain-repo", workItemId: 22, repoRoot: root, baseDir,
      installDeps: (d) => { calls.push(d); },
    });

    expect(calls).toEqual([]);
  });
});
