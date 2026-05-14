#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  buildKnowledgeGraphProvider,
  defaultSharedMemoryDbPath,
  defaultSharedMemoryInstallPrefix,
  defaultSharedMemoryWrapperPath,
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
const installPrefix = process.env.SHARED_MEMORY_INSTALL_PREFIX || defaultSharedMemoryInstallPrefix(homeDir);
const wrapperPath = process.env.SHARED_MEMORY_WRAPPER_PATH || defaultSharedMemoryWrapperPath(homeDir);
const provider = buildKnowledgeGraphProvider(dbPath, wrapperPath);

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

function installKnowledgeGraphRuntime(prefix: string): void {
  const npmPath = process.env.npm_execpath || "npm";
  const install = spawnSync(
    "npx",
    ["-y", "node@22", npmPath, "install", "--prefix", prefix, "knowledgegraph-mcp", "node@22"],
    { stdio: "inherit" },
  );
  if (install.status !== 0) {
    process.exit(install.status ?? 1);
  }
}

function renderWrapperScript(prefix: string): string {
  const nodePath = join(prefix, "node_modules", "node", "bin", "node");
  const entryPath = join(prefix, "node_modules", "knowledgegraph-mcp", "dist", "index.js");
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `exec ${JSON.stringify(nodePath)} ${JSON.stringify(entryPath)} "$@"`,
    "",
  ].join("\n");
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
  installKnowledgeGraphRuntime(installPrefix);
  writeText(wrapperPath, renderWrapperScript(installPrefix));
  chmodSync(wrapperPath, 0o755);
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
  console.log(`shared-memory setup: installed runtime ${installPrefix}`);
  console.log(`shared-memory setup: wrote wrapper ${wrapperPath}`);
  console.log(`shared-memory setup: SQLite path ${dbPath}`);
}
