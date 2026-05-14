#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  buildKnowledgeGraphProvider,
  defaultSharedMemoryDbPath,
  getSharedMemoryHomeDir,
  renderMemoryInstructionFile,
  renderClaudeConfig,
  renderCodexConfig,
  renderGeminiConfig,
  verifySharedMemoryConfigs,
} from "../src/sharedMemory.js";

const args = new Set(process.argv.slice(2));
const verifyOnly = args.has("--verify");

const homeDir = getSharedMemoryHomeDir(process.env, homedir());
const dbPath = process.env.SHARED_MEMORY_DB_PATH || defaultSharedMemoryDbPath(homeDir);
const provider = buildKnowledgeGraphProvider(dbPath);

const codexPath = join(homeDir, ".codex", "config.toml");
const geminiPath = join(homeDir, ".gemini", "settings.json");
const claudePath = join(homeDir, ".claude.json");
const codexInstructionsPath = join(homeDir, "AGENTS.md");
const geminiInstructionsPath = join(homeDir, "GEMINI.md");
const claudeInstructionsPath = join(homeDir, "CLAUDE.md");

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

const existingCodex = readText(codexPath);
const existingGemini = readText(geminiPath);
const existingClaude = readText(claudePath);
const existingCodexInstructions = readText(codexInstructionsPath);
const existingGeminiInstructions = readText(geminiInstructionsPath);
const existingClaudeInstructions = readText(claudeInstructionsPath);

const nextCodex = renderCodexConfig(existingCodex, provider);
const nextGemini = renderGeminiConfig(existingGemini, provider);
const nextClaude = renderClaudeConfig(existingClaude, provider);
const projectId = process.env.SHARED_MEMORY_PROJECT_ID || "server";
const nextCodexInstructions = renderMemoryInstructionFile(existingCodexInstructions, {
  agent: "codex",
  projectId,
  dbPath,
});
const nextGeminiInstructions = renderMemoryInstructionFile(existingGeminiInstructions, {
  agent: "gemini",
  projectId,
  dbPath,
});
const nextClaudeInstructions = renderMemoryInstructionFile(existingClaudeInstructions, {
  agent: "claude",
  projectId,
  dbPath,
});

if (!verifyOnly) {
  mkdirSync(dirname(dbPath), { recursive: true });
  writeText(codexPath, nextCodex);
  writeText(geminiPath, nextGemini);
  writeText(claudePath, nextClaude);
  writeText(codexInstructionsPath, nextCodexInstructions);
  writeText(geminiInstructionsPath, nextGeminiInstructions);
  writeText(claudeInstructionsPath, nextClaudeInstructions);
}

const result = verifySharedMemoryConfigs({
  codex: verifyOnly ? existingCodex : nextCodex,
  gemini: verifyOnly ? existingGemini : nextGemini,
  claude: verifyOnly ? existingClaude : nextClaude,
});

if (!result.ok) {
  for (const error of result.errors) {
    console.error(`shared-memory verify: ${error}`);
  }
  process.exit(1);
}

if (verifyOnly) {
  console.log(`shared-memory verify: OK (${dbPath})`);
} else {
  console.log(`shared-memory setup: wrote ${codexPath}`);
  console.log(`shared-memory setup: wrote ${geminiPath}`);
  console.log(`shared-memory setup: wrote ${claudePath}`);
  console.log(`shared-memory setup: wrote ${codexInstructionsPath}`);
  console.log(`shared-memory setup: wrote ${geminiInstructionsPath}`);
  console.log(`shared-memory setup: wrote ${claudeInstructionsPath}`);
  console.log(`shared-memory setup: SQLite path ${dbPath}`);
}
