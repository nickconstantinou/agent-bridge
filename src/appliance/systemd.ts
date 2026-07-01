import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { safeExec } from "./exec.js";

const UNIT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}[a-zA-Z0-9]$|^[a-zA-Z0-9]{2}$/;
const SYSTEMD_DIR = "/etc/systemd/system";

export function sanitizeUnitName(appName: string): string {
  const cleaned = appName.replace(/[^a-zA-Z0-9_.-]/g, "");
  return `ab-${cleaned}`;
}

export function generateUnit(opts: {
  appName: string;
  runtime: string;
  startCmd: string;
  port: number;
}): string {
  if (!UNIT_NAME_RE.test(opts.appName)) {
    throw new Error(`unsafe app name for systemd unit: ${opts.appName}`);
  }
  const unitName = sanitizeUnitName(opts.appName);
  const appDir = `/apps/${opts.appName}`;
  return `[Unit]
Description=Agent Bridge managed app: ${opts.appName}
After=network.target

[Service]
Type=simple
User=agentbridge
WorkingDirectory=${appDir}/repo
EnvironmentFile=${appDir}/.env
Environment=PORT=${opts.port}
ExecStart=/bin/sh -c ${JSON.stringify(opts.startCmd)}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${unitName}

[Install]
WantedBy=multi-user.target
`;
}

export async function writeUnit(appName: string, unitContent: string): Promise<void> {
  if (!UNIT_NAME_RE.test(appName)) throw new Error(`unsafe app name: ${appName}`);
  const unitName = sanitizeUnitName(appName);
  await writeFile(join(SYSTEMD_DIR, `${unitName}.service`), unitContent, { mode: 0o644 });
}

export async function reloadDaemon(): Promise<void> {
  const r = await safeExec("systemctl", ["daemon-reload"]);
  if (r.code !== 0) throw new Error(`daemon-reload failed: ${r.stderr}`);
}

export async function enableUnit(appName: string): Promise<void> {
  const unitName = `${sanitizeUnitName(appName)}.service`;
  const r = await safeExec("systemctl", ["enable", unitName]);
  if (r.code !== 0) throw new Error(`enable failed: ${r.stderr}`);
}

export async function startUnit(appName: string): Promise<void> {
  const unitName = `${sanitizeUnitName(appName)}.service`;
  const r = await safeExec("systemctl", ["start", unitName]);
  if (r.code !== 0) throw new Error(`start failed: ${r.stderr}`);
}

export async function restartUnit(appName: string): Promise<void> {
  const unitName = `${sanitizeUnitName(appName)}.service`;
  const r = await safeExec("systemctl", ["restart", unitName]);
  if (r.code !== 0) throw new Error(`restart failed: ${r.stderr}`);
}

export async function unitStatus(appName: string): Promise<string> {
  const unitName = `${sanitizeUnitName(appName)}.service`;
  const r = await safeExec("systemctl", ["status", "--no-pager", unitName]);
  return r.stdout + r.stderr;
}
