import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApplianceDb } from "./state.js";
import { unitStatus, restartUnit, sanitizeUnitName } from "./systemd.js";
import { safeExec } from "./exec.js";
import { checkHealth } from "./health.js";
import { redact } from "./redact.js";
import { APPS_BASE_DIR } from "./app-init.js";
import { parseManifest } from "./manifest.js";

export interface AppStatusReport {
  name: string;
  domain: string;
  port: number;
  commit: string | null;
  systemdStatus: string;
  healthResult: { ok: boolean; status: number | null; error: string | null };
  lastDeployStatus: string | null;
  lastDeployedAt: string | null;
  lastError: string | null;
}

export async function appStatus(db: ApplianceDb, appName: string): Promise<AppStatusReport> {
  const state = db.getApp(appName);
  if (!state) throw new Error(`App '${appName}' not found`);

  let healthPath = "/health";
  try {
    const ymlPath = join(APPS_BASE_DIR(), appName, "app.yml");
    const ymlContent = readFileSync(ymlPath, "utf8");
    const manifest = parseManifest(ymlContent);
    healthPath = manifest.health;
  } catch {
    // If yml is not readable or parse fails, use default "/health"
  }

  const [sysStatus, health] = await Promise.all([
    unitStatus(appName),
    checkHealth(`http://localhost:${state.port}${healthPath}`, 5000),
  ]);

  return {
    name: state.name,
    domain: state.domain,
    port: state.port,
    commit: state.current_commit,
    systemdStatus: redact(sysStatus),
    healthResult: { ok: health.ok, status: health.status, error: health.error },
    lastDeployStatus: state.last_deploy_status,
    lastDeployedAt: state.last_deployed_at,
    lastError: state.last_error,
  };
}

export async function appLogs(db: ApplianceDb, appName: string, lines = 100): Promise<string> {
  const state = db.getApp(appName);
  if (!state) throw new Error(`App '${appName}' not found`);
  const unitName = `${sanitizeUnitName(appName)}.service`;
  const r = await safeExec("journalctl", ["-u", unitName, "-n", String(lines), "--no-pager"]);
  return redact(r.stdout + r.stderr);
}

export async function appRestart(db: ApplianceDb, appName: string): Promise<void> {
  const state = db.getApp(appName);
  if (!state) throw new Error(`App '${appName}' not found`);
  await restartUnit(appName);
  db.upsertApp({
    ...state,
    last_deploy_status: "restarted",
    last_deployed_at: new Date().toISOString(),
  });
}
