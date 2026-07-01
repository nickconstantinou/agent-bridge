import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { WorkspaceState } from "./state.js";

export interface AppManifest {
  app: string;
  port: number;
  health: string;
  env?: Record<string, string>;
  startCommand?: string;
}

export interface DeployOptions {
  appsDir?: string;
  etcDir?: string;
  execCommand?: (cmd: string) => Promise<{ stdout: string; stderr: string }>;
  fetchProbe?: (url: string) => Promise<boolean>;
}

export function parseYaml(content: string): Record<string, any> {
  const result: Record<string, any> = {};
  const lines = content.split(/\r?\n/);
  let inEnv = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = line.match(/^\s*/)?.[0].length || 0;

    if (inEnv && indent >= 2) {
      const match = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
      if (match) {
        if (!result.env) result.env = {};
        let val = match[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.substring(1, val.length - 1);
        }
        result.env[match[1]] = val;
      }
      continue;
    } else {
      inEnv = false;
    }

    const match = trimmed.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (match) {
      const key = match[1];
      let val = match[2].trim();
      if (key === "env") {
        inEnv = true;
        continue;
      }
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.substring(1, val.length - 1);
      }
      if (key === "port") {
        result[key] = parseInt(val, 10);
      } else {
        result[key] = val;
      }
    }
  }
  return result;
}

export function validateManifest(manifest: any): AppManifest {
  if (!manifest.app) throw new Error("Manifest must contain 'app' name.");
  if (!manifest.port) throw new Error("Manifest must contain 'port'.");
  if (!manifest.health) throw new Error("Manifest must contain 'health' path.");

  if (!/^[a-zA-Z0-9_-]+$/.test(manifest.app)) {
    throw new Error("Invalid 'app' name. Only alphanumeric, dashes, and underscores allowed.");
  }

  if (typeof manifest.port !== "number" || manifest.port < 1 || manifest.port > 65535) {
    throw new Error("Invalid 'port'. Must be a number between 1 and 65535.");
  }

  if (!/^\/[a-zA-Z0-9_/-]*$/.test(manifest.health) || manifest.health.includes("..")) {
    throw new Error("Invalid 'health' path. Must start with / and not contain unsafe characters.");
  }

  if (manifest.env) {
    for (const [key, value] of Object.entries(manifest.env)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
        throw new Error(`Invalid environment variable key: ${key}`);
      }
      if (typeof value !== "string") {
        throw new Error(`Environment variable value for ${key} must be a string.`);
      }
      if (/[\$\`\n\r;\|&><]/.test(value)) {
        throw new Error(`Unsafe character detected in environment variable value for ${key}.`);
      }
    }
  }

  return {
    app: manifest.app,
    port: manifest.port,
    health: manifest.health,
    env: manifest.env,
    startCommand: manifest.startCommand || "node index.js",
  };
}

export function redactSecrets(text: string, manifest: AppManifest): string {
  let redacted = text;
  if (manifest.env) {
    for (const [key, value] of Object.entries(manifest.env)) {
      const isSecretKey = /secret|token|password|key/i.test(key);
      if (isSecretKey && value.length > 0) {
        redacted = redacted.replaceAll(value, "[REDACTED]");
      }
    }
  }
  return redacted;
}

export async function deployApp(
  state: WorkspaceState,
  manifestContent: string,
  appSourceDir: string,
  options: DeployOptions = {}
): Promise<{ success: boolean; logs: string; releaseTag: string }> {
  const appsDir = options.appsDir || "/apps";
  const etcDir = options.etcDir || "/etc";
  
  const exec = options.execCommand || (async (cmd: string) => {
    const { exec } = await import("node:child_process");
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      exec(cmd, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  });

  const probe = options.fetchProbe || (async (url: string) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return res.status === 200;
    } catch {
      return false;
    }
  });

  let manifest: AppManifest;
  try {
    const parsed = parseYaml(manifestContent);
    manifest = validateManifest(parsed);
  } catch (err: any) {
    return { success: false, logs: `Manifest validation failed: ${err.message}`, releaseTag: "" };
  }

  const app = manifest.app;
  const timestamp = Date.now().toString();
  const releasesDir = path.join(appsDir, app, "releases");
  const releasePath = path.join(releasesDir, timestamp);
  const sharedDir = path.join(appsDir, app, "shared");
  const currentLink = path.join(appsDir, app, "current");

  let deployLogs = `Starting deployment of app '${app}'...\n`;

  try {
    // 1. Create directories
    fs.mkdirSync(releasePath, { recursive: true });
    fs.mkdirSync(sharedDir, { recursive: true });

    // 2. Copy source code
    fs.cpSync(appSourceDir, releasePath, { recursive: true });
    deployLogs += `Copied source files to release directory: ${releasePath}\n`;

    // 3. Initialize SQLite DB
    const dbPath = path.join(sharedDir, "app.sqlite");
    if (!fs.existsSync(dbPath)) {
      const db = new Database(dbPath);
      db.close();
      deployLogs += `Created shared SQLite database: ${dbPath}\n`;
    }

    // 4. Link SQLite database inside release
    const releaseDbLink = path.join(releasePath, "app.sqlite");
    if (fs.existsSync(releaseDbLink)) {
      fs.rmSync(releaseDbLink, { force: true });
    }
    fs.symlinkSync(dbPath, releaseDbLink);
    deployLogs += `Symlinked SQLite database inside release directory\n`;

    // 5. Generate systemd service file
    const serviceName = `${app}.service`;
    const servicePath = path.join(etcDir, "systemd", "system", serviceName);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });

    const envLines = Object.entries(manifest.env || {})
      .map(([k, v]) => `Environment="${k}=${v}"`)
      .join("\n");

    const systemdUnit = `[Unit]
Description=Agent Bridge App - ${app}
After=network.target

[Service]
Type=simple
WorkingDirectory=${currentLink}
ExecStart=${manifest.startCommand}
Restart=always
Environment="PORT=${manifest.port}"
${envLines}

[Install]
WantedBy=multi-user.target
`;
    fs.writeFileSync(servicePath, systemdUnit, "utf8");
    deployLogs += `Generated systemd service unit file at ${servicePath}\n`;

    // 6. Generate Caddyfile fragment
    const caddyConfDir = path.join(etcDir, "caddy", "conf.d");
    fs.mkdirSync(caddyConfDir, { recursive: true });
    const caddyFragmentPath = path.join(caddyConfDir, `${app}.caddy`);
    const caddyFragment = `${state.domain} {
    reverse_proxy localhost:${manifest.port}
}
`;
    fs.writeFileSync(caddyFragmentPath, caddyFragment, "utf8");
    deployLogs += `Generated Caddyfile fragment at ${caddyFragmentPath}\n`;

    // 7. Update symlink atomically
    const tempLink = path.join(appsDir, app, `current_tmp_${timestamp}`);
    fs.symlinkSync(releasePath, tempLink);
    fs.renameSync(tempLink, currentLink);
    deployLogs += `Updated active release symlink to ${releasePath}\n`;

    // 8. Execute service start and Caddy reload
    deployLogs += `Reloading systemd daemon and restarting service...\n`;
    await exec("systemctl daemon-reload");
    await exec(`systemctl restart ${app}`);
    deployLogs += `Reloading Caddy router...\n`;
    await exec("systemctl reload caddy");

    // 9. Probe health endpoint
    deployLogs += `Probing health endpoint: http://localhost:${manifest.port}${manifest.health} ...\n`;
    let isHealthy = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      isHealthy = await probe(`http://localhost:${manifest.port}${manifest.health}`);
      if (isHealthy) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!isHealthy) {
      deployLogs += `Health probe failed! Initiating rollback...\n`;
      const rollbackOk = await rollbackApp(state, app, options);
      if (rollbackOk) {
        deployLogs += `Rollback executed successfully.\n`;
      } else {
        deployLogs += `Rollback failed or no previous release available.\n`;
      }
      return { success: false, logs: redactSecrets(deployLogs, manifest), releaseTag: "" };
    }

    deployLogs += `Health probe passed! Deployment completed successfully.\n`;
    return { success: true, logs: redactSecrets(deployLogs, manifest), releaseTag: timestamp };
  } catch (err: any) {
    deployLogs += `Deployment error encountered: ${err.message}\n`;
    return { success: false, logs: redactSecrets(deployLogs, manifest), releaseTag: "" };
  }
}

export async function rollbackApp(
  state: WorkspaceState,
  app: string,
  options: DeployOptions = {}
): Promise<boolean> {
  const appsDir = options.appsDir || "/apps";
  const etcDir = options.etcDir || "/etc";

  const exec = options.execCommand || (async (cmd: string) => {
    const { exec } = await import("node:child_process");
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      exec(cmd, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  });

  const releasesDir = path.join(appsDir, app, "releases");
  const currentLink = path.join(appsDir, app, "current");

  if (!fs.existsSync(releasesDir)) return false;

  const releases = fs.readdirSync(releasesDir)
    .filter(name => /^\d+$/.test(name))
    .sort((a, b) => Number(b) - Number(a));

  if (releases.length < 2) {
    try {
      await exec(`systemctl stop ${app}`);
      const servicePath = path.join(etcDir, "systemd", "system", `${app}.service`);
      if (fs.existsSync(servicePath)) fs.rmSync(servicePath, { force: true });
      const caddyFragmentPath = path.join(etcDir, "caddy", "conf.d", `${app}.caddy`);
      if (fs.existsSync(caddyFragmentPath)) fs.rmSync(caddyFragmentPath, { force: true });
      if (fs.existsSync(currentLink)) fs.rmSync(currentLink, { force: true });
      await exec("systemctl daemon-reload");
      await exec("systemctl reload caddy");
    } catch {}
    return false;
  }

  const prevRelease = releases[1];
  const prevReleasePath = path.join(releasesDir, prevRelease);

  try {
    const tempLink = path.join(appsDir, app, `current_tmp_${prevRelease}`);
    if (fs.existsSync(tempLink)) fs.rmSync(tempLink, { force: true });
    fs.symlinkSync(prevReleasePath, tempLink);
    fs.renameSync(tempLink, currentLink);

    await exec("systemctl daemon-reload");
    await exec(`systemctl restart ${app}`);
    await exec("systemctl reload caddy");
    return true;
  } catch {
    return false;
  }
}

export async function getAppLogs(
  app: string,
  lines = 100,
  options: DeployOptions = {}
): Promise<string> {
  const exec = options.execCommand || (async (cmd: string) => {
    const { exec } = await import("node:child_process");
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      exec(cmd, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  });

  try {
    const { stdout } = await exec(`journalctl -u ${app} -n ${lines} --no-pager`);
    return stdout;
  } catch (err: any) {
    return `Failed to fetch logs: ${err.message}`;
  }
}
