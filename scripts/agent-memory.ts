#!/usr/bin/env node
import { addMemory, deleteMemory, exportMemoryJson, listMemories, recallMemories, searchMemories, updateMemory } from "../src/agentMemory.js";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

const command = process.argv[2];
const json = hasFlag("--json");
const scope = (argValue("--scope") as any) || undefined;
const type = (argValue("--type") as any) || undefined;
const query = argValue("--query") || "";
const text = argValue("--text") || "";
const id = argValue("--id") || "";
const limit = Number(argValue("--limit") || 10);

try {
  if (command === "add") {
    if (!type || !scope || !text) throw new Error("Usage: agent-memory add --type <type> --scope <scope> --text <text>");
    const record = addMemory({ type, scope, text });
    process.stdout.write(json ? exportMemoryJson([record]) : `${record.id}\n`);
  } else if (command === "recall" || command === "search") {
    if (!query) throw new Error(`Usage: agent-memory ${command} --query <query> [--scope <scope>] [--limit N]`);
    const records = command === "recall" ? recallMemories({ query, scope, limit }) : searchMemories({ query, scope, limit });
    process.stdout.write(json ? exportMemoryJson(records) : records.map((r) => `${r.id}\t${r.text}`).join("\n") + (records.length ? "\n" : ""));
  } else if (command === "list") {
    const records = listMemories({ scope, limit });
    process.stdout.write(json ? exportMemoryJson(records) : records.map((r) => `${r.id}\t${r.text}`).join("\n") + (records.length ? "\n" : ""));
  } else if (command === "delete") {
    if (!id) throw new Error("Usage: agent-memory delete --id <memory_id>");
    const ok = deleteMemory(id);
    process.stdout.write(json ? exportMemoryJson([{ id, type: "note", scope: "project", text: ok ? "deleted" : "not found", created_at: new Date().toISOString(), source: "manual" } as any]) : `${ok ? "deleted" : "not found"}\n`);
  } else if (command === "update") {
    if (!id) throw new Error("Usage: agent-memory update --id <memory_id> [--type <type>] [--scope <scope>] [--text <text>]");
    const record = updateMemory({ id, type, scope, text: text || undefined });
    process.stdout.write(json ? exportMemoryJson([record]) : `${record.id}\n`);
  } else {
    process.stderr.write("Commands: add, recall, search, list, update, delete\n");
    process.exit(1);
  }
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
}
