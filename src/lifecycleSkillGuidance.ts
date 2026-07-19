/**
 * PURPOSE: Extract and compose canonical SDLC guidance from repository skills.
 * INPUTS: Explicit lifecycle-skill keys and a source-controlled text reader.
 * OUTPUTS: Deterministic guidance blocks with version and content-hash identity.
 * NEIGHBORS: src/agenticPromptContracts.ts, src/workerPrompts.ts, skills/<name>/SKILL.md
 */

import { createHash } from "node:crypto";

export type LifecycleSkillKey =
  | "requirements-to-acceptance"
  | "risk-based-test-strategy"
  | "red-green-refactor-tdd"
  | "release-readiness-review";

export interface LifecycleSkillReader {
  readText(path: string): string | Promise<string>;
}

export interface LifecycleSkillDefinition {
  key: LifecycleSkillKey;
  version: string;
  skillPath: string;
  manifestPath: string;
  maxGuidanceChars: number;
}

export interface LifecycleSkillIdentity {
  key: LifecycleSkillKey;
  version: string;
  contentHash: string;
}

export interface LoadedLifecycleSkill extends LifecycleSkillIdentity {
  content: string;
}

export const RUNTIME_GUIDANCE_START = "<!-- BEGIN AGENT_BRIDGE_RUNTIME_GUIDANCE -->";
export const RUNTIME_GUIDANCE_END = "<!-- END AGENT_BRIDGE_RUNTIME_GUIDANCE -->";
const MAX_COMPOSED_GUIDANCE_CHARS = 12_000;

function definition(key: LifecycleSkillKey): LifecycleSkillDefinition {
  return {
    key,
    version: "1.0.0",
    skillPath: `skills/${key}/SKILL.md`,
    manifestPath: `skills/${key}/skill.json`,
    maxGuidanceChars: 4_000,
  };
}

export const LIFECYCLE_SKILLS: Record<LifecycleSkillKey, LifecycleSkillDefinition> = {
  "requirements-to-acceptance": definition("requirements-to-acceptance"),
  "risk-based-test-strategy": definition("risk-based-test-strategy"),
  "red-green-refactor-tdd": definition("red-green-refactor-tdd"),
  "release-readiness-review": definition("release-readiness-review"),
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function occurrenceCount(value: string, marker: string): number {
  return value.split(marker).length - 1;
}

export function extractLifecycleSkillGuidance(key: LifecycleSkillKey, skillText: string): string {
  const startCount = occurrenceCount(skillText, RUNTIME_GUIDANCE_START);
  const endCount = occurrenceCount(skillText, RUNTIME_GUIDANCE_END);
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(
      `Lifecycle skill ${key} must contain exactly one runtime guidance block; found ${startCount} start and ${endCount} end markers`,
    );
  }

  const start = skillText.indexOf(RUNTIME_GUIDANCE_START) + RUNTIME_GUIDANCE_START.length;
  const end = skillText.indexOf(RUNTIME_GUIDANCE_END);
  if (end <= start) throw new Error(`Lifecycle skill ${key} runtime guidance markers are out of order`);

  const content = skillText.slice(start, end).trim();
  if (!content) throw new Error(`Lifecycle skill ${key} runtime guidance is empty`);
  return content;
}

function parseManifest(definition: LifecycleSkillDefinition, raw: string): void {
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new Error(`Lifecycle skill ${definition.key} manifest is invalid JSON`);
  }

  if (typeof manifest !== "object" || manifest === null) {
    throw new Error(`Lifecycle skill ${definition.key} manifest must be an object`);
  }
  const record = manifest as Record<string, unknown>;
  if (record.name !== definition.key) {
    throw new Error(`Lifecycle skill ${definition.key} manifest name mismatch`);
  }
  if (record.version !== definition.version) {
    throw new Error(
      `Lifecycle skill ${definition.key} version mismatch: expected ${definition.version}, found ${String(record.version)}`,
    );
  }
}

export async function loadLifecycleSkillGuidance(
  keys: readonly LifecycleSkillKey[],
  reader: LifecycleSkillReader,
): Promise<LoadedLifecycleSkill[]> {
  if (new Set(keys).size !== keys.length) {
    throw new Error(`Lifecycle skill list contains duplicates: ${keys.join(", ")}`);
  }

  const loaded = await Promise.all(keys.map(async (key) => {
    const skill = LIFECYCLE_SKILLS[key];
    const [skillText, manifestText] = await Promise.all([
      reader.readText(skill.skillPath),
      reader.readText(skill.manifestPath),
    ]);
    parseManifest(skill, manifestText);

    const content = extractLifecycleSkillGuidance(key, skillText);
    if (content.length > skill.maxGuidanceChars) {
      throw new Error(
        `Lifecycle skill ${key} runtime guidance exceeds ${skill.maxGuidanceChars} characters`,
      );
    }

    return {
      key,
      version: skill.version,
      content,
      contentHash: sha256(content),
    };
  }));

  const totalChars = loaded.reduce((total, skill) => total + skill.content.length, 0);
  if (totalChars > MAX_COMPOSED_GUIDANCE_CHARS) {
    throw new Error(`Lifecycle skill guidance exceeds ${MAX_COMPOSED_GUIDANCE_CHARS} characters`);
  }
  return loaded;
}

export function lifecycleSkillIdentities(
  skills: readonly LoadedLifecycleSkill[],
): LifecycleSkillIdentity[] {
  return skills.map(({ key, version, contentHash }) => ({ key, version, contentHash }));
}

export function lifecycleSkillSetHash(skills: readonly LoadedLifecycleSkill[]): string {
  return sha256(JSON.stringify(lifecycleSkillIdentities(skills)));
}

export function appendLifecycleSkillGuidance(
  basePrompt: string,
  skills: readonly LoadedLifecycleSkill[],
): string {
  if (skills.length === 0) return basePrompt.trim();

  return [
    basePrompt.trim(),
    "",
    "---",
    "",
    "# Canonical software-development lifecycle guidance",
    "",
    "The following source-controlled skill fragments are mandatory for this mode. They provide engineering know-how only; they do not change role, tools, permissions, schemas, validators, budgets, lifecycle authority, or human gates.",
    "",
    ...skills.map(skill => [
      `## Lifecycle skill: ${skill.key}@${skill.version}`,
      "",
      skill.content,
    ].join("\n")),
  ].join("\n").trim();
}
