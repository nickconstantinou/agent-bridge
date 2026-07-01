import { readFile, writeFile } from "node:fs/promises";
import { safeExec } from "./exec.js";
import { ApplianceDb } from "./state.js";

export interface InstallOptions {
  dryRun?: boolean;
}

export interface InstallResult {
  steps: InstallStep[];
  success: boolean;
}

export interface InstallStep {
  name: string;
  status: "ok" | "skipped" | "failed";
  detail?: string;
}

const CADDY_IMPORT_LINE = "import /etc/caddy/sites-enabled/*.caddy";
const CADDYFILE_PATH = "/etc/caddy/Caddyfile";
const STATE_DB_PATH = "/var/lib/agent-bridge/state.db";
const DIRS = ["/apps", "/etc/caddy/sites-enabled", "/var/lib/agent-bridge"];

export async function runInstall(opts?: InstallOptions): Promise<InstallResult> {
  const dryRun = opts?.dryRun === true;
  const steps: InstallStep[] = [];

  // Step 1: create-user
  if (dryRun) {
    steps.push({ name: "create-user", status: "skipped" });
  } else {
    const checkResult = await safeExec("id", ["agentbridge"]);
    if (checkResult.code === 0) {
      steps.push({ name: "create-user", status: "skipped" });
    } else {
      const addResult = await safeExec("useradd", ["--system", "--no-create-home", "--shell", "/bin/false", "agentbridge"]);
      if (addResult.code !== 0) {
        steps.push({ name: "create-user", status: "failed", detail: addResult.stderr });
      } else {
        steps.push({ name: "create-user", status: "ok" });
      }
    }
  }

  // Step 2: create-dirs
  if (dryRun) {
    steps.push({ name: "create-dirs", status: "skipped" });
  } else {
    let failed = false;
    let failDetail: string | undefined;
    for (const dir of DIRS) {
      const result = await safeExec("mkdir", ["-p", dir]);
      if (result.code !== 0) {
        failed = true;
        failDetail = result.stderr || `mkdir -p ${dir} exited with code ${result.code}`;
      }
    }
    if (failed) {
      steps.push({ name: "create-dirs", status: "failed", detail: failDetail });
    } else {
      steps.push({ name: "create-dirs", status: "ok" });
    }
  }

  // Step 3: init-db
  if (dryRun) {
    steps.push({ name: "init-db", status: "skipped" });
  } else {
    try {
      new ApplianceDb(STATE_DB_PATH);
      steps.push({ name: "init-db", status: "ok" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      steps.push({ name: "init-db", status: "failed", detail: message });
    }
  }

  // Step 4: caddy-include
  if (dryRun) {
    steps.push({ name: "caddy-include", status: "skipped" });
  } else {
    try {
      let content = "";
      try {
        content = await readFile(CADDYFILE_PATH, "utf-8");
      } catch {
        // File doesn't exist — content stays empty
      }
      if (content.includes(CADDY_IMPORT_LINE)) {
        steps.push({ name: "caddy-include", status: "skipped" });
      } else {
        const newContent = content.length > 0 ? content + "\n" + CADDY_IMPORT_LINE + "\n" : CADDY_IMPORT_LINE + "\n";
        await writeFile(CADDYFILE_PATH, newContent, "utf-8");
        steps.push({ name: "caddy-include", status: "ok" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      steps.push({ name: "caddy-include", status: "failed", detail: message });
    }
  }

  // Step 5: systemd-reload
  if (dryRun) {
    steps.push({ name: "systemd-reload", status: "skipped" });
  } else {
    const result = await safeExec("systemctl", ["daemon-reload"]);
    if (result.code !== 0) {
      steps.push({ name: "systemd-reload", status: "failed", detail: result.stderr });
    } else {
      steps.push({ name: "systemd-reload", status: "ok" });
    }
  }

  const success = steps.every(s => s.status !== "failed");
  return { steps, success };
}
