#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const targets = [
  "/home/content-crawler/.codex/config.toml",
  "/home/content-crawler/.gemini/settings.json",
  "/home/content-crawler/.claude.json",
];

for (const path of targets) {
  if (!existsSync(path)) continue;
  let text = readFileSync(path, "utf8");
  text = text.replace(/\n?\[mcp_servers\.shared_memory\][\s\S]*?(?=\n\[|$)/g, "\n");
  text = text.replace(/"shared_memory"\s*:\s*\{[\s\S]*?\}\s*,?/g, "");
  text = text.replace(/"command"\s*:\s*"\/home\/openclaw\/\.local\/bin\/agent-bridge-knowledgegraph-mcp"/g, '"command": "agent-memory"');
  text = text.replace(/"KNOWLEDGEGRAPH_SQLITE_PATH"/g, '"AGENT_MEMORY_DB_PATH"');
  text = text.replace(/\n{3,}/g, "\n\n");
  writeFileSync(path, text.trimEnd() + "\n", "utf8");
  console.log(`updated ${path}`);
}

console.log("removed legacy shared-memory config");
