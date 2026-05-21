/**
 * PURPOSE: Shared skills catalog installation, verification, and uninstall helpers.
 * INPUTS: Bundled skill folders, a target home directory, lockfile contents, and link mode options.
 * OUTPUTS: Installed skill folders, native CLI skill links or copies, lockfile records, and verification results.
 * NEIGHBORS: scripts/skill-manager.ts, scripts/install.sh
 * LOGIC: Maintains a shared ~/.agents/skills store, projects skills into native CLI skill directories, and preserves lockfile metadata.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SkillLinkMode = "symlink" | "copy";

export interface SkillCatalogEntry {
  name: string;
  version: string;
  description: string;
  path: string;
}

export interface SkillPaths {
  homeDir: string;
  agentsSkillsDir: string;
  codexSkillsDir: string;
  geminiSkillsDir: string;
  claudeSkillsDir: string;
  lockfilePath: string;
}

export interface InstallSkillOptions {
  homeDir?: string;
  repoRoot?: string;
  force?: boolean;
  linkMode?: SkillLinkMode;
  now?: Date;
}

export interface VerifySkillOptions {
  homeDir?: string;
  repoRoot?: string;
  fix?: boolean;
}

export interface UninstallSkillOptions {
  homeDir?: string;
}

export interface VerifySkillResult {
  ok: boolean;
  errors: string[];
  repaired: string[];
}

type SkillLockRecord = {
  source?: string;
  sourceType?: string;
  skillPath?: string;
  skillFolderHash?: string;
  linkMode?: SkillLinkMode;
  installedAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
};

type SkillLockfile = {
  version?: number;
  skills?: Record<string, SkillLockRecord>;
  [key: string]: unknown;
};

const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = join(moduleDir, "..");

export function getSharedSkillsHomeDir(env: { SHARED_MEMORY_HOME?: string; HOME?: string } = process.env, fallbackHome = homedir()): string {
  return env.SHARED_MEMORY_HOME || env.HOME || fallbackHome;
}

export function resolveSkillPaths(homeDir = getSharedSkillsHomeDir()): SkillPaths {
  return {
    homeDir,
    agentsSkillsDir: join(homeDir, ".agents", "skills"),
    codexSkillsDir: join(homeDir, ".codex", "skills"),
    geminiSkillsDir: join(homeDir, ".gemini", "antigravity", "skills"),
    claudeSkillsDir: join(homeDir, ".claude", "skills"),
    lockfilePath: join(homeDir, ".agents", ".skill-lock.json"),
  };
}

export function listLocalCatalog(repoRoot = defaultRepoRoot): SkillCatalogEntry[] {
  const skillsDir = join(repoRoot, "skills");
  if (!existsSync(skillsDir)) return [];

  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readCatalogEntry(join(skillsDir, entry.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function installSkillGlobal(skillName: string, options: InstallSkillOptions = {}): void {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const paths = resolveSkillPaths(options.homeDir);
  const linkMode = options.linkMode ?? "symlink";
  const sourceDir = join(repoRoot, "skills", skillName);
  if (!existsSync(sourceDir)) throw new Error(`Unknown bundled skill: ${skillName}`);
  validateLinkMode(linkMode);
  readCatalogEntry(sourceDir);

  mkdirSync(paths.agentsSkillsDir, { recursive: true });
  const destDir = join(paths.agentsSkillsDir, skillName);
  if (existsSync(destDir)) {
    const currentHash = hashDirectory(destDir);
    const sourceHash = hashDirectory(sourceDir);
    if (!options.force) throw new Error(`Skill already installed: ${skillName}`);
    if (currentHash !== sourceHash) rmSync(destDir, { recursive: true, force: true });
  }
  if (!existsSync(destDir)) cpSync(sourceDir, destDir, { recursive: true });

  const lockfile = readLockfile(paths.lockfilePath, { force: options.force });
  const installedHash = hashDirectory(destDir);
  const now = (options.now ?? new Date()).toISOString();
  const previous = lockfile.skills?.[skillName] ?? {};
  lockfile.version ??= 3;
  lockfile.skills ??= {};
  lockfile.skills[skillName] = {
    ...previous,
    source: "shared-local",
    sourceType: "local",
    skillPath: `skills/${skillName}/SKILL.md`,
    skillFolderHash: installedHash,
    linkMode,
    installedAt: typeof previous.installedAt === "string" ? previous.installedAt : now,
    updatedAt: now,
  };

  for (const nativeDir of nativeSkillDirs(paths)) {
    projectNativeSkill({ skillName, sharedDir: destDir, nativeDir, linkMode, force: options.force });
  }

  writeJsonAtomic(paths.lockfilePath, lockfile);
}

export function verifySkillGlobal(skillName?: string, options: VerifySkillOptions = {}): VerifySkillResult {
  const paths = resolveSkillPaths(options.homeDir);
  const errors: string[] = [];
  const repaired: string[] = [];
  let lockfile: SkillLockfile;
  try {
    lockfile = readLockfile(paths.lockfilePath, { force: false });
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)], repaired };
  }

  const names = skillName ? [skillName] : Object.keys(lockfile.skills ?? {}).sort();
  for (const name of names) {
    const record = lockfile.skills?.[name];
    if (!record) {
      errors.push(`Skill is not registered in lockfile: ${name}`);
      continue;
    }
    const sharedDir = join(paths.agentsSkillsDir, name);
    if (!existsSync(sharedDir)) {
      errors.push(`Installed skill folder is missing: ${sharedDir}`);
      continue;
    }
    const sharedHash = hashDirectory(sharedDir);
    if (record.skillFolderHash && record.skillFolderHash !== sharedHash) {
      errors.push(`Installed skill hash mismatch: ${name}`);
    }

    const linkMode = record.linkMode === "copy" ? "copy" : "symlink";
    for (const nativeDir of nativeSkillDirs(paths)) {
      const nativePath = join(nativeDir, name);
      const problem = verifyNativeSkill({ nativePath, sharedDir, linkMode, expectedHash: sharedHash });
      if (!problem) continue;
      if (options.fix) {
        projectNativeSkill({ skillName: name, sharedDir, nativeDir, linkMode, force: true });
        repaired.push(nativePath);
      } else {
        errors.push(problem);
      }
    }
  }

  return { ok: errors.length === 0, errors, repaired };
}

export function uninstallSkillGlobal(skillName: string, options: UninstallSkillOptions = {}): void {
  const paths = resolveSkillPaths(options.homeDir);
  const lockfile = readLockfile(paths.lockfilePath, { force: false });

  for (const nativeDir of nativeSkillDirs(paths)) {
    rmSync(join(nativeDir, skillName), { recursive: true, force: true });
  }
  rmSync(join(paths.agentsSkillsDir, skillName), { recursive: true, force: true });
  if (lockfile.skills) delete lockfile.skills[skillName];
  writeJsonAtomic(paths.lockfilePath, lockfile);
}

export function hashDirectory(dir: string): string {
  const hash = createHash("sha1");
  for (const file of listFilesRecursive(dir)) {
    const rel = relative(dir, file).split("\\").join("/");
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readCatalogEntry(skillDir: string): SkillCatalogEntry {
  const manifestPath = join(skillDir, "skill.json");
  const skillPath = join(skillDir, "SKILL.md");
  if (!existsSync(manifestPath)) throw new Error(`Missing skill.json: ${skillDir}`);
  if (!existsSync(skillPath)) throw new Error(`Missing SKILL.md: ${skillDir}`);

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown; version?: unknown; description?: unknown };
  const frontmatter = readFileSync(skillPath, "utf8").match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter?.[1].includes(`name: ${manifest.name}`) || !frontmatter[1].includes("description:")) {
    throw new Error(`SKILL.md frontmatter is invalid: ${skillPath}`);
  }
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string" || typeof manifest.description !== "string") {
    throw new Error(`Invalid skill.json: ${manifestPath}`);
  }
  if (manifest.name !== basename(skillDir)) throw new Error(`Skill manifest name does not match folder: ${skillDir}`);
  return { name: manifest.name, version: manifest.version, description: manifest.description, path: skillDir };
}

function readLockfile(path: string, options: { force?: boolean }): SkillLockfile {
  if (!existsSync(path)) return { version: 3, skills: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SkillLockfile;
    parsed.skills ??= {};
    return parsed;
  } catch (error) {
    if (!options.force) throw new Error(`Unable to parse skill lockfile: ${path}`);
    const backup = `${path}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(path, backup);
    return { version: 3, skills: {} };
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function nativeSkillDirs(paths: SkillPaths): string[] {
  return [paths.codexSkillsDir, paths.geminiSkillsDir, paths.claudeSkillsDir];
}

function projectNativeSkill(input: { skillName: string; sharedDir: string; nativeDir: string; linkMode: SkillLinkMode; force?: boolean }): void {
  mkdirSync(input.nativeDir, { recursive: true });
  const nativePath = join(input.nativeDir, input.skillName);
  if (pathExists(nativePath)) {
    if (!input.force && !isExpectedNativeEntry(nativePath, input.sharedDir, input.linkMode)) {
      throw new Error(`Native skill path already exists: ${nativePath}`);
    }
    rmSync(nativePath, { recursive: true, force: true });
  }

  if (input.linkMode === "copy") {
    cpSync(input.sharedDir, nativePath, { recursive: true });
    return;
  }
  const target = relative(input.nativeDir, input.sharedDir);
  symlinkSync(target, nativePath, "dir");
}

function isExpectedNativeEntry(nativePath: string, sharedDir: string, linkMode: SkillLinkMode): boolean {
  try {
    const stat = lstatSync(nativePath);
    if (linkMode === "symlink") {
      return stat.isSymbolicLink() && resolve(dirname(nativePath), readlinkSync(nativePath)) === resolve(sharedDir);
    }
    return stat.isDirectory() && hashDirectory(nativePath) === hashDirectory(sharedDir);
  } catch {
    return false;
  }
}

function verifyNativeSkill(input: { nativePath: string; sharedDir: string; linkMode: SkillLinkMode; expectedHash: string }): string | null {
  if (!pathExists(input.nativePath)) return `Native skill entry is missing: ${input.nativePath}`;
  if (!existsSync(join(input.nativePath, "SKILL.md"))) return `Native skill SKILL.md is missing or unreadable: ${input.nativePath}`;
  const stat = lstatSync(input.nativePath);
  if (input.linkMode === "symlink") {
    if (!stat.isSymbolicLink()) return `Native skill entry is not a symlink: ${input.nativePath}`;
    if (resolve(dirname(input.nativePath), readlinkSync(input.nativePath)) !== resolve(input.sharedDir)) return `Native skill symlink target is stale: ${input.nativePath}`;
    return null;
  }
  if (!stat.isDirectory()) return `Native skill entry is not a directory copy: ${input.nativePath}`;
  if (hashDirectory(input.nativePath) !== input.expectedHash) return `Native skill copied directory hash mismatch: ${input.nativePath}`;
  return null;
}

function listFilesRecursive(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursive(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function validateLinkMode(linkMode: string): asserts linkMode is SkillLinkMode {
  if (linkMode !== "symlink" && linkMode !== "copy") throw new Error(`Invalid link mode: ${linkMode}`);
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
