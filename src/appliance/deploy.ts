import { writeFile, chmod } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ApplianceDb } from "./state.js";
import { parseManifest } from "./manifest.js";
import { safeExec } from "./exec.js";
import { generateUnit, writeUnit, reloadDaemon, enableUnit, restartUnit } from "./systemd.js";
import { writeCaddyBlock, reloadCaddy } from "./caddy.js";
import { checkHealth } from "./health.js";
import { APPS_BASE_DIR } from "./app-init.js";

export interface DeployResult {
  commit: string;
  healthOk: boolean;
  healthStatus: number | null;
  error: string | null;
}

async function gitEnsureRepo(repoDir: string, repo: string, branch: string): Promise<void> {
  const headAbsent = !existsSync(join(repoDir, "HEAD"));
  const isEmpty = headAbsent && (!existsSync(repoDir) || readdirSync(repoDir).length === 0);
  if (isEmpty) {
    const r = await safeExec("git", ["clone", "--", repo, repoDir]);
    if (r.code !== 0) throw new Error(`git clone failed: ${r.stderr}`);
  } else {
    let r = await safeExec("git", ["-C", repoDir, "fetch", "origin"]);
    if (r.code !== 0) throw new Error(`git fetch failed: ${r.stderr}`);
    r = await safeExec("git", ["-C", repoDir, "reset", "--hard", `origin/${branch}`]);
    if (r.code !== 0) throw new Error(`git reset failed: ${r.stderr}`);
  }
}

async function getCommit(repoDir: string): Promise<string> {
  const r = await safeExec("git", ["-C", repoDir, "rev-parse", "HEAD"]);
  if (r.code !== 0) throw new Error(`git rev-parse failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function installDeps(repoDir: string, runtime: string): Promise<void> {
  if (runtime === "node") {
    const r = await safeExec("npm", ["ci", "--prefer-offline"], { cwd: repoDir, timeoutMs: 300_000 });
    if (r.code !== 0) throw new Error(`npm ci failed: ${r.stderr}`);
  } else if (runtime === "python") {
    const r = await safeExec("pip", ["install", "-r", "requirements.txt"], { cwd: repoDir, timeoutMs: 300_000 });
    if (r.code !== 0) throw new Error(`pip install failed: ${r.stderr}`);
  }
  // static: skip
}

async function runBuild(repoDir: string, buildCmd: string): Promise<void> {
  if (!buildCmd || buildCmd === "skip") return;
  const r = await safeExec("sh", ["-c", buildCmd], { cwd: repoDir, timeoutMs: 600_000 });
  if (r.code !== 0) throw new Error(`build failed: ${r.stderr}`);
}

async function healthWithRetry(
  url: string,
  retries = 3,
  delayMs = 2000,
): Promise<{ ok: boolean; status: number | null }> {
  for (let i = 0; i < retries - 1; i++) {
    const r = await checkHealth(url, 10_000);
    if (r.ok) return r;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return checkHealth(url, 10_000);
}

export async function deployApp(db: ApplianceDb, appName: string): Promise<DeployResult> {
  const state = db.getApp(appName);
  if (!state) throw new Error(`App '${appName}' not found`);

  const appDir = join(APPS_BASE_DIR(), appName);
  const repoDir = join(appDir, "repo");

  let commit = "";
  try {
    const appYml = readFileSync(join(appDir, "app.yml"), "utf8");
    const manifest = parseManifest(appYml);

    await gitEnsureRepo(repoDir, state.repo, state.branch);
    commit = await getCommit(repoDir);

    await installDeps(repoDir, state.runtime);
    await runBuild(repoDir, manifest.build);

    // Write .env if not exists
    const envPath = join(appDir, ".env");
    if (!existsSync(envPath)) {
      await writeFile(envPath, `PORT=${state.port}\n`);
      await chmod(envPath, 0o600);
    }

    // Touch app.sqlite if not exists
    const dbPath = join(appDir, "app.sqlite");
    if (!existsSync(dbPath)) {
      await writeFile(dbPath, "");
    }

    // Systemd unit
    const unitContent = generateUnit({
      appName,
      runtime: state.runtime,
      startCmd: manifest.start,
      port: state.port,
    });
    await writeUnit(appName, unitContent);
    await reloadDaemon();
    await enableUnit(appName);
    await restartUnit(appName);

    // Caddy
    await writeCaddyBlock(appName, state.domain, state.port);
    await reloadCaddy();

    // Health check
    const healthUrl = `http://localhost:${state.port}${manifest.health}`;
    const health = await healthWithRetry(healthUrl);

    db.upsertApp({
      ...state,
      current_commit: commit,
      previous_commit: state.current_commit,
      last_deploy_status: health.ok ? "success" : "unhealthy",
      last_health_status: health.status !== null ? String(health.status) : (health.ok ? "ok" : "error"),
      last_deployed_at: new Date().toISOString(),
      last_error: health.ok ? null : `health check failed: ${health.status ?? "error"}`,
    });

    return { commit, healthOk: health.ok, healthStatus: health.status, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    db.upsertApp({
      ...state,
      last_deploy_status: "failed",
      last_error: message,
    });
    return { commit, healthOk: false, healthStatus: null, error: message };
  }
}
