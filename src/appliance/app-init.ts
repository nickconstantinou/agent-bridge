import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApplianceDb } from "./state.js";
import { type AppManifest, validateManifest, serializeManifest } from "./manifest.js";

export const APPS_BASE_DIR = (): string => process.env.APPS_BASE_DIR ?? "/apps";

export async function appInit(
  db: ApplianceDb,
  input: Partial<AppManifest> & { name: string; repo: string; domain: string },
): Promise<AppManifest> {
  // Fill defaults
  const manifest: AppManifest = {
    runtime: "node",
    branch: "main",
    database: "sqlite",
    health: "/health",
    build: "npm run build",
    start: "npm run start",
    ...input,
    port: input.port ?? db.allocatePort(),
  };

  const errors = validateManifest(manifest);
  if (errors.length > 0) throw new Error(`Invalid manifest: ${errors.join("; ")}`);

  const existing = db.getApp(manifest.name);
  if (existing) throw new Error(`App '${manifest.name}' already exists`);

  const appDir = join(APPS_BASE_DIR(), manifest.name);
  // Safety: ensure appDir stays under APPS_BASE_DIR
  const base = APPS_BASE_DIR();
  if (!appDir.startsWith(base + "/") && appDir !== base) {
    throw new Error(`Unsafe app directory path: ${appDir}`);
  }

  mkdirSync(join(appDir, "repo"), { recursive: true });
  mkdirSync(join(appDir, "logs"), { recursive: true });
  writeFileSync(join(appDir, "app.yml"), serializeManifest(manifest), { mode: 0o644 });

  db.upsertApp({
    name: manifest.name,
    repo: manifest.repo,
    branch: manifest.branch,
    port: manifest.port,
    domain: manifest.domain,
    runtime: manifest.runtime,
    current_commit: null,
    previous_commit: null,
    last_deploy_status: null,
    last_health_status: null,
    last_deployed_at: null,
    last_error: null,
  });

  return manifest;
}
