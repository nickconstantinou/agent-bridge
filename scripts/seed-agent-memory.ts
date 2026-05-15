#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { importMemoryText } from "../src/agentMemory.js";

const workspaceRoot = process.env.OPENCLAW_WORKSPACE_ROOT || join(process.cwd(), "..", "..");
const memoryRoot = join(workspaceRoot, "memory");
const rootMemory = join(workspaceRoot, "MEMORY.md");

function collectCandidateLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const candidates: string[] = [];
  let active = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("## ")) {
      active = /Key Findings|Promoted|Possible Lasting Truths|Planning Notes|Open Questions|Systems Status/i.test(line);
      continue;
    }
    if (active && line.startsWith("- ")) {
      candidates.push(line.replace(/^-\s+/, "").trim());
    }
  }
  return candidates;
}

function readCandidates(path: string): string[] {
  if (!existsSync(path)) return [];
  return collectCandidateLines(readFileSync(path, "utf8"));
}

const sources: string[] = [];
if (existsSync(rootMemory)) sources.push(rootMemory);
if (existsSync(memoryRoot)) {
  for (const name of readdirSync(memoryRoot)) {
    if (name.endsWith(".md")) sources.push(join(memoryRoot, name));
  }
}

let seeded = 0;
for (const source of sources) {
  const scope = source.endsWith("MEMORY.md") ? "project" : "project";
  for (const text of readCandidates(source)) {
    const imported = importMemoryText({ type: "note", scope, text, source: `openclaw:${source}` });
    if (imported) seeded += 1;
  }
}

console.log(`seeded ${seeded} memories from OpenClaw memory files`);
