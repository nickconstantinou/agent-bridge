/**
 * PURPOSE: Manages shared-memory instruction injection and verification for different agent interfaces.
 * INPUTS: DB paths, markdown files, project routes, and existing file content.
 * OUTPUTS: Modified instruction files content, script render outputs, and verification statuses.
 * NEIGHBORS: src/index.ts, scripts/setup-shared-memory.ts
 * LOGIC: Provides template builders for agent memory CLI configuration, checks for the presence of memory blocks, and formats instructions.
 */

import { isAbsolute } from "node:path";

export interface VerifySharedMemoryResult {
  ok: boolean;
  errors: string[];
}

const blockStart = "<!-- agent-bridge:agent-memory:start -->";
const blockEnd = "<!-- agent-bridge:agent-memory:end -->";

export function defaultAgentMemoryDbPath(homeDir: string): string {
  return `${homeDir}/.agent-bridge/shared-memory/agent-memory.sqlite`;
}

export function defaultAgentMemoryWrapperPath(homeDir: string): string {
  return `${homeDir}/.local/bin/agent-memory`;
}

export function getSharedMemoryHomeDir(env: { SHARED_MEMORY_HOME?: string; HOME?: string }, fallbackHome?: string): string {
  return env.SHARED_MEMORY_HOME || env.HOME || fallbackHome || "";
}

export function renderAgentMemoryWrapperScript(input: { repoRoot: string }): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `cd ${JSON.stringify(input.repoRoot)}`,
    'exec npm run agent-memory -- "$@"',
    "",
  ].join("\n");
}

export function renderAgentMemoryInstructionFile(existingContent: string, agent: "codex" | "antigravity" | "claude", dbPath: string): string {
  const title = agent === "codex" ? "Codex" : agent === "antigravity" ? "Antigravity" : "Claude";
  const block = [
    blockStart,
    "## Persistent memory",
    "",
    `Agent: ${title}`,
    `SQLite database: \`${dbPath}\``,
    "",
    "Use the local memory CLI named `agent-memory` when the task depends on prior project decisions, architecture, bugs, conventions, commands, or unresolved TODOs.",
    "Before making architectural decisions or modifying important behaviour, run:",
    "",
    'agent-memory recall --query "<short relevant query>" --scope project --limit 10',
    "",
    "When you learn a durable project fact, decision, bug fix, convention, or recurring issue, save it:",
    "",
    'agent-memory add --type decision --scope project --text "<concise memory>"',
    "",
    "Do not save secrets, API keys, passwords, transient logs, or private personal information.",
    "Do not rely on MCP for memory.",
    blockEnd,
  ].join("\n");
  const pattern = new RegExp(`${blockStart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[\\s\\S]*?${blockEnd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m");
  const existing = existingContent.trim();
  if (!existing) return `${block}\n`;
  if (pattern.test(existingContent)) return `${existingContent.replace(pattern, block).trim()}\n`;
  return `${existing}\n\n${block}\n`;
}

export function verifySharedMemoryConfigs(configs: { codex: string; antigravity: string; claude: string }): VerifySharedMemoryResult {
  const errors: string[] = [];
  if (!configs.codex.includes("agent-memory recall") || !configs.codex.includes("Do not rely on MCP for memory.")) errors.push("Codex instructions missing agent-memory block.");
  if (!configs.antigravity.includes("agent-memory recall") || !configs.antigravity.includes("Do not rely on MCP for memory.")) errors.push("Antigravity instructions missing agent-memory block.");
  if (!configs.claude.includes("agent-memory recall") || !configs.claude.includes("Do not rely on MCP for memory.")) errors.push("Claude instructions missing agent-memory block.");
  return { ok: errors.length === 0, errors };
}
