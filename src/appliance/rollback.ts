import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { ApplianceDb } from "./state.js";
import { safeExec } from "./exec.js";
import { restartUnit } from "./systemd.js";
import { checkHealth } from "./health.js";
import { APPS_BASE_DIR } from "./app-init.js";
import { parseManifest } from "./manifest.js";

export interface RollbackResult {
  previousCommit: string;
  healthOk: boolean;
  error: string | null;
}

export async function rollbackApp(
  db: ApplianceDb,
  appName: string
): Promise<RollbackResult> {
  try {
    const app = db.getApp(appName);
    if (!app) {
      return { previousCommit: "", healthOk: false, error: `App '${appName}' not found` };
    }

    if (!app.previous_commit) {
      return {
        previousCommit: "",
        healthOk: false,
        error: `App '${appName}' has no previous commit to roll back to`,
      };
    }

    const appYml = await readFile(join(APPS_BASE_DIR(), appName, "app.yml"), "utf8");
    const manifest = parseManifest(appYml);

    const repoDir = join(APPS_BASE_DIR(), appName, "repo");
    await safeExec("git", ["-C", repoDir, "checkout", app.previous_commit]);

    await restartUnit(appName);

    const healthResult = await checkHealth(
      `http://localhost:${app.port}${manifest.health}`,
      10_000
    );

    db.upsertApp({
      ...app,
      current_commit: app.previous_commit,
      previous_commit: app.current_commit,
      last_deploy_status: healthResult.ok ? "rollback-success" : "rollback-unhealthy",
    });

    return { previousCommit: app.previous_commit, healthOk: healthResult.ok, error: null };
  } catch (err: any) {
    return { previousCommit: "", healthOk: false, error: err.message };
  }
}
