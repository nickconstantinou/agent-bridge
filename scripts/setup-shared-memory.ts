#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  defaultAgentMemoryDbPath,
  defaultAgentMemoryWrapperPath,
  getSharedMemoryHomeDir,
  renderAgentMemoryInstructionFile,
  renderAgentMemoryWrapperScript,
  verifySharedMemoryConfigs,
} from "../src/sharedMemory.js";

const args = new Set(process.argv.slice(2));
const verifyOnly = args.has("--verify");

const homeDir = getSharedMemoryHomeDir(process.env, homedir());
const dbPath = process.env.AGENT_MEMORY_DB_PATH || defaultAgentMemoryDbPath(homeDir);
const wrapperPath = process.env.AGENT_MEMORY_WRAPPER_PATH || defaultAgentMemoryWrapperPath(homeDir);

const codexInstructionsPath = join(homeDir, "AGENTS.md");
const geminiInstructionsPath = join(homeDir, "GEMINI.md");
const claudeInstructionsPath = join(homeDir, "CLAUDE.md");
const repoRoot = join(process.cwd());

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

const existingCodexInstructions = readText(codexInstructionsPath);
const existingGeminiInstructions = readText(geminiInstructionsPath);
const existingClaudeInstructions = readText(claudeInstructionsPath);

const nextCodexInstructions = renderAgentMemoryInstructionFile(existingCodexInstructions, "codex", dbPath);
const nextGeminiInstructions = renderAgentMemoryInstructionFile(existingGeminiInstructions, "gemini", dbPath);
const nextClaudeInstructions = renderAgentMemoryInstructionFile(existingClaudeInstructions, "claude", dbPath);

if (!verifyOnly) {
  const wrapper = renderAgentMemoryWrapperScript({ repoRoot });
  writeText(wrapperPath, wrapper);
  chmodSync(wrapperPath, 0o755);
  writeText(codexInstructionsPath, nextCodexInstructions);
  writeText(geminiInstructionsPath, nextGeminiInstructions);
  writeText(claudeInstructionsPath, nextClaudeInstructions);
  spawnSync("npx", ["tsx", "scripts/seed-agent-memory.ts"], { stdio: "inherit" });
}

const result = verifySharedMemoryConfigs({ codex: nextCodexInstructions, gemini: nextGeminiInstructions, claude: nextClaudeInstructions });
if (!result.ok) {
  for (const error of result.errors) console.error(`shared-memory verify: ${error}`);
  process.exit(1);
}

if (verifyOnly) {
  console.log(`shared-memory verify: OK (${dbPath})`);
} else {
  console.log(`shared-memory setup: wrote ${codexInstructionsPath}`);
  console.log(`shared-memory setup: wrote ${geminiInstructionsPath}`);
  console.log(`shared-memory setup: wrote ${claudeInstructionsPath}`);
  console.log(`shared-memory setup: wrote wrapper ${wrapperPath}`);
  console.log(`shared-memory setup: SQLite path ${dbPath}`);
}
