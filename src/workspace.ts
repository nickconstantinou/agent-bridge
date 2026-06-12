/**
 * PURPOSE: Per-job git workspaces for autonomous implementation jobs.
 * TDD jobs must never mutate the live checkout the worker runs from: each job
 * clones the local source repo into a disposable directory whose origin points
 * at the source's real remote, so pushes still reach GitHub.
 * NEIGHBORS: src/handlers/tddImplementation.ts, src/handlers/prLifecycle.ts, src/index-worker.ts
 */

import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function gitAsync(args: string[], cwd?: string): Promise<string> {
  return new Promise<string>((res, rej) => {
    execFile("git", args, { encoding: "utf8", cwd }, (err, stdout, stderr) => {
      if (err) rej(new Error((stderr || "").trim() || err.message));
      else res(stdout.trim());
    });
  });
}

export function defaultRepoRoot(): string {
  return process.env.WORKER_REPO_ROOT || homedir();
}

export function defaultWorkspaceBaseDir(): string {
  return process.env.WORKER_WORKSPACE_DIR || join(homedir(), "agent-bridge-workspaces");
}

/**
 * Map a repository name ("agent-bridge" or "owner/agent-bridge") to a local
 * git checkout under the repo root. Returns null when none exists.
 */
export function resolveLocalRepoPath(repository: string, repoRoot = defaultRepoRoot()): string | null {
  const name = repository.includes("/") ? repository.split("/").pop()! : repository;
  if (!name) return null;
  const path = join(repoRoot, name);
  return existsSync(join(path, ".git")) ? path : null;
}

export interface PrepareWorkspaceOptions {
  repository: string;
  workItemId: number;
  repoRoot?: string;
  baseDir?: string;
  /** Install project dependencies in the clone (called when package.json exists). */
  installDeps?: (dir: string) => Promise<void> | void;
}

/**
 * Clone the local source checkout into baseDir/work-<id>. Any stale directory
 * from a previous attempt is removed first so retries always start clean.
 */
export async function prepareWorkspace(opts: PrepareWorkspaceOptions): Promise<string> {
  const { repository, workItemId, repoRoot = defaultRepoRoot(), baseDir = defaultWorkspaceBaseDir() } = opts;

  const source = resolveLocalRepoPath(repository, repoRoot);
  if (!source) {
    throw new Error(`No local checkout found for repository '${repository}' under ${repoRoot}`);
  }

  const dir = join(baseDir, `work-${workItemId}`);
  rmSync(dir, { recursive: true, force: true });

  await gitAsync(["clone", "-q", source, dir]);

  // A local clone's origin points at the local path; repoint it at the real
  // remote so branch pushes reach GitHub.
  const originUrl = await gitAsync(["remote", "get-url", "origin"], source).catch(() => "");
  if (originUrl) {
    await gitAsync(["remote", "set-url", "origin", originUrl], dir);
  }

  // Repo-local identity: the service account has no global git config, and
  // commits in the workspace must not depend on it.
  await gitAsync(["config", "user.name", process.env.WORKER_GIT_NAME || "agent-bridge worker"], dir);
  await gitAsync(["config", "user.email", process.env.WORKER_GIT_EMAIL || "agent-bridge-worker@users.noreply.github.com"], dir);

  // A clone without dependencies cannot run its test suite — install them so
  // red/green verification actually verifies something.
  if (opts.installDeps && existsSync(join(dir, "package.json"))) {
    await opts.installDeps(dir);
  }

  return dir;
}

/**
 * Returns a cleanup function that only ever deletes paths inside baseDir —
 * a misrouted path is a no-op, never a deletion.
 */
export function createWorkspaceCleanup(baseDir = defaultWorkspaceBaseDir()): (dir: string) => void {
  const base = resolve(baseDir);
  return (dir: string) => {
    const target = resolve(dir);
    if (!target.startsWith(base + "/") && target !== base) return;
    if (target === base) return; // never delete the base itself
    rmSync(target, { recursive: true, force: true });
  };
}
