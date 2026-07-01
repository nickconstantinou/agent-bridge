import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isValidDomain } from "./manifest.js";
import { safeExec } from "./exec.js";

const CADDY_SITES_DIR = process.env.CADDY_SITES_DIR ?? "/etc/caddy/sites-enabled";

export function validateDomain(domain: string): void {
  if (!isValidDomain(domain)) throw new Error(`invalid domain: ${domain}`);
}

export function generateCaddyBlock(domain: string, port: number): string {
  validateDomain(domain);
  return `${domain} {\n\treverse_proxy localhost:${port}\n}\n`;
}

export async function writeCaddyBlock(appName: string, domain: string, port: number): Promise<void> {
  validateDomain(domain);
  // Sanitize appName for filename — only allow safe chars
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}[a-zA-Z0-9]$|^[a-zA-Z0-9]{2}$/.test(appName)) {
    throw new Error(`unsafe app name for caddy config: ${appName}`);
  }
  const content = generateCaddyBlock(domain, port);
  await writeFile(join(CADDY_SITES_DIR, `${appName}.caddy`), content, { mode: 0o644 });
}

export async function reloadCaddy(): Promise<void> {
  const r = await safeExec("systemctl", ["reload", "caddy"]);
  if (r.code !== 0) throw new Error(`caddy reload failed: ${r.stderr}`);
}
