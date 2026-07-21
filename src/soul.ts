/**
 * PURPOSE: Loads and compacts optional SOUL.md persona context for CLI prompt injection.
 * INPUTS: Markdown persona files, environment-derived mode/path options, and prompt-size limits.
 * OUTPUTS: Compact soul contract text or null when disabled/missing.
 * NEIGHBORS: src/cli.ts, src/index.ts, docs/soul.md
 * LOGIC: Parses persona sections in stable order, including configurable response style, caps output size, and preserves bridge safety precedence.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type SoulMode = "summary" | "full" | "off";

const DEFAULT_SUMMARY_MAX_CHARS = 4_000;
const DEFAULT_FULL_MAX_CHARS = 12_000;
const MIN_SECTION_MAX_CHARS = 320;

const SECTION_ORDER = [
  "Identity",
  "Values",
  "Communication Style",
  "Expertise",
  "Boundaries",
  "Workflow",
  "Tool Usage",
  "Memory Policy",
  "Example Interactions",
] as const;

type SoulSectionName = (typeof SECTION_ORDER)[number];

export function defaultSoulPath(projectDir: string = process.env.BRIDGE_PROJECT_DIR || process.cwd()): string {
  return join(projectDir, "SOUL.md");
}

export function normalizeSoulMode(raw: string | undefined): SoulMode {
  if (raw === "full" || raw === "off" || raw === "summary") return raw;
  return "summary";
}

export function loadSoulContext(input: { mode?: SoulMode; path?: string; maxChars?: number }): string | null {
  const mode = input.mode ?? "summary";
  if (mode === "off") return null;

  const path = input.path ?? defaultSoulPath();
  if (!existsSync(path)) return null;

  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return null;

  if (mode === "full") {
    return capText(raw, input.maxChars ?? DEFAULT_FULL_MAX_CHARS);
  }

  return capText(renderSummary(raw), input.maxChars ?? DEFAULT_SUMMARY_MAX_CHARS);
}

export function renderSoulContract(context: string | null): string | null {
  if (!context?.trim()) return null;
  return [
    "Soul contract:",
    context.trim(),
  ].join("\n");
}

function renderSummary(markdown: string): string {
  const sections = parseSections(markdown);
  const lines: string[] = [];
  const presentSections = SECTION_ORDER.filter((name) => sections.has(name));
  const sectionMaxChars = Math.max(
    MIN_SECTION_MAX_CHARS,
    Math.floor((DEFAULT_SUMMARY_MAX_CHARS - 400) / Math.max(1, presentSections.length)),
  );

  for (const name of SECTION_ORDER) {
    const content = sections.get(name);
    if (!content) continue;
    lines.push(`## ${name}`);
    lines.push(capText(content, sectionMaxChars));
    lines.push("");
  }

  if (!lines.length) {
    lines.push(capText(stripMarkdownTitle(markdown), DEFAULT_SUMMARY_MAX_CHARS));
    lines.push("");
  }

  lines.push("Higher-priority bridge/system/developer instructions always win.");
  return lines.join("\n").trim();
}

function parseSections(markdown: string): Map<SoulSectionName, string> {
  const result = new Map<SoulSectionName, string>();
  const aliases = new Map<string, SoulSectionName>(SECTION_ORDER.map((name) => [normalizeHeading(name), name]));
  const lines = markdown.split(/\r?\n/);
  let current: SoulSectionName | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (!current) return;
    const text = buffer.join("\n").trim();
    if (text) result.set(current, text);
  };

  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) {
      flush();
      current = aliases.get(normalizeHeading(match[1])) ?? null;
      buffer = [];
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();
  return result;
}

function normalizeHeading(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function stripMarkdownTitle(markdown: string): string {
  return markdown.replace(/^#\s+.+(?:\r?\n)+/, "").trim();
}

function capText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 16)).trimEnd()}\n[truncated]`;
}
