import { isAbsolute } from "node:path";

export interface SharedMemoryProvider {
  providerId: string;
  serverName: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  storageKind: "sqlite";
  storagePath: string;
}

export interface ParsedSharedMemoryConfig {
  serverName: string;
  command: string;
  args: string[];
  dbPath: string | null;
}

export interface VerifySharedMemoryResult {
  ok: boolean;
  errors: string[];
}

export interface SharedMemorySetupPlan {
  installs: string[];
  errors: string[];
}

const memoryBlockStart = "<!-- agent-bridge:shared-memory:start -->";
const memoryBlockEnd = "<!-- agent-bridge:shared-memory:end -->";

export function defaultSharedMemoryDbPath(homeDir: string): string {
  return `${homeDir}/.agent-bridge/shared-memory/knowledgegraph.sqlite`;
}

export function defaultSharedMemoryInstallPrefix(homeDir: string): string {
  return `${homeDir}/.agent-bridge/shared-memory/provider`;
}

export function defaultSharedMemoryWrapperPath(homeDir: string): string {
  return `${homeDir}/.local/bin/agent-bridge-knowledgegraph-mcp`;
}

export function getSharedMemoryHomeDir(env: {
  SHARED_MEMORY_HOME?: string | undefined;
  HOME?: string | undefined;
}, fallbackHome?: string): string {
  return env.SHARED_MEMORY_HOME || env.HOME || fallbackHome || "";
}

export function buildKnowledgeGraphProvider(
  storagePath: string,
  commandPath: string,
): SharedMemoryProvider {
  return {
    providerId: "knowledgegraph-mcp",
    serverName: "shared_memory",
    command: commandPath,
    args: [],
    env: {
      KNOWLEDGEGRAPH_SQLITE_PATH: storagePath,
    },
    storageKind: "sqlite",
    storagePath,
  };
}

export function renderMemoryInstructionFile(existingContent: string, input: {
  agent: "codex" | "gemini" | "claude";
  projectId: string;
  dbPath: string;
}): string {
  const label = input.agent === "codex" ? "Codex" : input.agent === "gemini" ? "Gemini" : "Claude";
  const section = [
    memoryBlockStart,
    "## Shared Memory",
    "",
    `Agent: ${label}`,
    `Shared SQLite: \`${input.dbPath}\``,
    "",
    "- Use `search_knowledge` at the start of each task when prior project context may matter.",
    `- Always include \`project_id: "${input.projectId}"\` when reading or writing shared memory.`,
    "- Record durable project facts and architectural decisions with `add_observations`.",
    "- Do not store ephemeral chat noise, tentative brainstorming, or repeated status updates.",
    memoryBlockEnd,
  ].join("\n");

  const trimmed = existingContent.trim();
  const pattern = new RegExp(
    `${memoryBlockStart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${memoryBlockEnd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    "m",
  );

  if (!trimmed) return `${section}\n`;
  if (pattern.test(existingContent)) {
    return `${existingContent.replace(pattern, section).trim()}\n`;
  }
  return `${trimmed}\n\n${section}\n`;
}

function renderCodexSection(provider: SharedMemoryProvider): string {
  const envEntries = Object.entries(provider.env)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join(", ");

  return [
    `[mcp_servers.${provider.serverName}]`,
    `command = ${JSON.stringify(provider.command)}`,
    `args = [${provider.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
    `env = { ${envEntries} }`,
  ].join("\n");
}

export function renderCodexConfig(existingContent: string, provider: SharedMemoryProvider): string {
  const section = renderCodexSection(provider);
  const trimmed = existingContent.trim();
  if (!trimmed) return `${section}\n`;

  const lines = trimmed.split("\n");
  const output: string[] = [];
  let replaced = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === `[mcp_servers.${provider.serverName}]`) {
      if (!replaced) {
        output.push(section);
        replaced = true;
      }
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("[")) {
        index += 1;
      }
      index -= 1;
      continue;
    }
    output.push(line);
  }

  const normalized = output.join("\n").trim();
  if (replaced) return `${normalized}\n`;
  return `${normalized}\n\n${section}\n`;
}

function parseJsonConfig(content: string): Record<string, unknown> {
  if (!content.trim()) return {};
  return JSON.parse(content) as Record<string, unknown>;
}

function renderJsonConfig(
  existingContent: string,
  provider: SharedMemoryProvider,
): string {
  const parsed = parseJsonConfig(existingContent);
  const mcpServers = {
    ...(((parsed.mcpServers as Record<string, unknown> | undefined) ?? {})),
    [provider.serverName]: {
      command: provider.command,
      args: provider.args,
      env: provider.env,
    },
  };
  const next = {
    ...parsed,
    mcpServers,
  };
  return `${JSON.stringify(next, null, 2)}\n`;
}

export function renderGeminiConfig(existingContent: string, provider: SharedMemoryProvider): string {
  return renderJsonConfig(existingContent, provider);
}

export function renderClaudeConfig(existingContent: string, provider: SharedMemoryProvider): string {
  return renderJsonConfig(existingContent, provider);
}

function parseArgs(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .map((part) => part.replace(/^"/, "").replace(/"$/, ""));
}

export function parseCodexSharedMemoryConfig(content: string): ParsedSharedMemoryConfig | null {
  const sectionPattern = /\[mcp_servers\.shared_memory\]\n([\s\S]*?)(?=\n\[|\s*$)/;
  const sectionMatch = content.match(sectionPattern);
  if (!sectionMatch) return null;
  const section = sectionMatch[1];
  let command = "";
  let args: string[] = [];
  let dbPath: string | null = null;

  for (const rawLine of section.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("command = ")) {
      command = line.slice("command = ".length).trim().replace(/^"/, "").replace(/"$/, "");
      continue;
    }
    if (line.startsWith("args = [")) {
      const argsRaw = line.slice("args = [".length, -1);
      args = parseArgs(argsRaw);
      continue;
    }
    if (line.startsWith("env = {")) {
      dbPath =
        line.match(/KNOWLEDGEGRAPH_SQLITE_PATH\s*=\s*"([^"]+)"/)?.[1] ?? null;
    }
  }

  return {
    serverName: "shared_memory",
    command,
    args,
    dbPath,
  };
}

function parseJsonSharedMemoryConfig(content: string): ParsedSharedMemoryConfig | null {
  const parsed = parseJsonConfig(content);
  const server = (parsed.mcpServers as Record<string, any> | undefined)?.shared_memory;
  if (!server) return null;
  return {
    serverName: "shared_memory",
    command: typeof server.command === "string" ? server.command : "",
    args: Array.isArray(server.args) ? server.args.map(String) : [],
    dbPath: typeof server.env?.KNOWLEDGEGRAPH_SQLITE_PATH === "string"
      ? server.env.KNOWLEDGEGRAPH_SQLITE_PATH
      : null,
  };
}

export function parseGeminiSharedMemoryConfig(content: string): ParsedSharedMemoryConfig | null {
  return parseJsonSharedMemoryConfig(content);
}

export function parseClaudeSharedMemoryConfig(content: string): ParsedSharedMemoryConfig | null {
  return parseJsonSharedMemoryConfig(content);
}

export function verifySharedMemoryConfigs(configs: {
  codex: string;
  gemini: string;
  claude: string;
}): VerifySharedMemoryResult {
  const errors: string[] = [];
  const parsed = [
    parseCodexSharedMemoryConfig(configs.codex),
    parseGeminiSharedMemoryConfig(configs.gemini),
    parseClaudeSharedMemoryConfig(configs.claude),
  ];

  if (parsed.some((entry) => entry == null)) {
    errors.push("All CLI configs must define the shared_memory MCP server.");
    return { ok: false, errors };
  }

  const complete = parsed as ParsedSharedMemoryConfig[];
  const dbPaths = new Set(complete.map((entry) => entry.dbPath));
  if (dbPaths.size !== 1) {
    errors.push("All CLI configs must point at the same SQLite path.");
  }

  const dbPath = complete[0].dbPath;
  if (!dbPath || !isAbsolute(dbPath)) {
    errors.push("Shared memory database path must be absolute.");
  }

  const commands = new Set(complete.map((entry) => entry.command));
  if (commands.size !== 1) {
    errors.push("All CLI configs must use the same shared memory command.");
  }

  const argLists = new Set(complete.map((entry) => JSON.stringify(entry.args)));
  if (argLists.size !== 1) {
    errors.push("All CLI configs must use the same shared memory arguments.");
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function buildSharedMemorySetupPlan(input: {
  hasNode: boolean;
  hasCodex: boolean;
  hasGemini: boolean;
  hasClaude: boolean;
  dbPath: string;
  installPrefix: string;
  wrapperPath: string;
}): SharedMemorySetupPlan {
  const installs: string[] = [];
  const errors: string[] = [];

  if (!input.hasNode) {
    errors.push("Node.js 22+ is required for the installer.");
    return { installs, errors };
  }

  if (!isAbsolute(input.dbPath)) {
    errors.push("Shared memory SQLite path must be absolute.");
  }
  if (!isAbsolute(input.installPrefix)) {
    errors.push("Shared memory install prefix must be absolute.");
  }
  if (!isAbsolute(input.wrapperPath)) {
    errors.push("Shared memory wrapper path must be absolute.");
  }

  if (!input.hasCodex) installs.push("npm install -g @openai/codex");
  if (!input.hasGemini) installs.push("npm install -g @google/gemini-cli");
  if (!input.hasClaude) installs.push("npm install -g @anthropic-ai/claude-code");
  installs.push(`npx -y node@22 $(which npm) install --prefix "${input.installPrefix}" knowledgegraph-mcp node@22`);

  return { installs, errors };
}
