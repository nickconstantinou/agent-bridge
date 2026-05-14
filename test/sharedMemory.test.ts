import { describe, expect, it } from "vitest";
import {
  buildKnowledgeGraphProvider,
  buildSharedMemorySetupPlan,
  defaultSharedMemoryDbPath,
  getSharedMemoryHomeDir,
  parseClaudeSharedMemoryConfig,
  parseCodexSharedMemoryConfig,
  parseGeminiSharedMemoryConfig,
  renderClaudeConfig,
  renderCodexConfig,
  renderGeminiConfig,
  verifySharedMemoryConfigs,
} from "../src/sharedMemory.js";

describe("shared memory provider", () => {
  it("builds a knowledgegraph provider with sqlite defaults", () => {
    const provider = buildKnowledgeGraphProvider("/tmp/shared-memory.db");
    expect(provider.providerId).toBe("knowledgegraph-mcp");
    expect(provider.serverName).toBe("shared_memory");
    expect(provider.command).toBe("npx");
    expect(provider.args).toEqual(["-y", "knowledgegraph-mcp"]);
    expect(provider.env).toEqual({
      KNOWLEDGEGRAPH_SQLITE_PATH: "/tmp/shared-memory.db",
    });
  });

  it("uses an absolute db path under the home directory by default", () => {
    expect(defaultSharedMemoryDbPath("/home/tester")).toBe(
      "/home/tester/.agent-bridge/shared-memory/knowledgegraph.sqlite",
    );
  });

  it("prefers an explicit shared-memory home over HOME", () => {
    const home = getSharedMemoryHomeDir({
      SHARED_MEMORY_HOME: "/home/openclaw",
      HOME: "/root",
    });
    expect(home).toBe("/home/openclaw");
  });
});

describe("codex config rendering", () => {
  it("appends a shared memory section when absent", () => {
    const rendered = renderCodexConfig("", buildKnowledgeGraphProvider("/tmp/shared-memory.db"));
    expect(rendered).toContain("[mcp_servers.shared_memory]");
    expect(rendered).toContain('command = "npx"');
    expect(rendered).toContain('args = ["-y", "knowledgegraph-mcp"]');
    expect(rendered).toContain('KNOWLEDGEGRAPH_SQLITE_PATH = "/tmp/shared-memory.db"');
  });

  it("replaces an existing shared memory section without touching other sections", () => {
    const existing = `
[foo]
bar = "baz"

[mcp_servers.shared_memory]
command = "old"
args = ["bad"]
env = { KNOWLEDGEGRAPH_SQLITE_PATH = "/tmp/old.db" }

[mcp_servers.other]
command = "keep"
`.trim();

    const rendered = renderCodexConfig(
      existing,
      buildKnowledgeGraphProvider("/tmp/shared-memory.db"),
    );

    expect(rendered).toContain('[foo]\nbar = "baz"');
    expect(rendered).toContain('[mcp_servers.other]\ncommand = "keep"');
    expect(rendered).not.toContain('command = "old"');
    expect(rendered).toContain('KNOWLEDGEGRAPH_SQLITE_PATH = "/tmp/shared-memory.db"');
  });
});

describe("json config rendering", () => {
  it("adds shared memory to gemini settings while preserving unrelated data", () => {
    const existing = JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } });
    const rendered = renderGeminiConfig(existing, buildKnowledgeGraphProvider("/tmp/shared-memory.db"));
    const parsed = JSON.parse(rendered);
    expect(parsed.theme).toBe("dark");
    expect(parsed.mcpServers.other.command).toBe("x");
    expect(parsed.mcpServers.shared_memory.command).toBe("npx");
    expect(parsed.mcpServers.shared_memory.env.KNOWLEDGEGRAPH_SQLITE_PATH).toBe("/tmp/shared-memory.db");
  });

  it("adds shared memory to claude config while preserving unrelated data", () => {
    const existing = JSON.stringify({ projects: [], mcpServers: { existing: { command: "x" } } });
    const rendered = renderClaudeConfig(existing, buildKnowledgeGraphProvider("/tmp/shared-memory.db"));
    const parsed = JSON.parse(rendered);
    expect(parsed.projects).toEqual([]);
    expect(parsed.mcpServers.existing.command).toBe("x");
    expect(parsed.mcpServers.shared_memory.args).toEqual(["-y", "knowledgegraph-mcp"]);
  });
});

describe("config parsing", () => {
  it("extracts shared memory settings from each config format", () => {
    const provider = buildKnowledgeGraphProvider("/tmp/shared-memory.db");
    const codex = parseCodexSharedMemoryConfig(renderCodexConfig("", provider));
    const gemini = parseGeminiSharedMemoryConfig(renderGeminiConfig("{}", provider));
    const claude = parseClaudeSharedMemoryConfig(renderClaudeConfig("{}", provider));

    expect(codex?.dbPath).toBe("/tmp/shared-memory.db");
    expect(gemini?.dbPath).toBe("/tmp/shared-memory.db");
    expect(claude?.dbPath).toBe("/tmp/shared-memory.db");
  });
});

describe("shared memory verification", () => {
  it("passes when all configs point to the same provider and db path", () => {
    const provider = buildKnowledgeGraphProvider("/tmp/shared-memory.db");
    const result = verifySharedMemoryConfigs({
      codex: renderCodexConfig("", provider),
      gemini: renderGeminiConfig("{}", provider),
      claude: renderClaudeConfig("{}", provider),
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails when one cli points at a different database path", () => {
    const good = buildKnowledgeGraphProvider("/tmp/shared-memory.db");
    const bad = buildKnowledgeGraphProvider("/tmp/other.db");
    const result = verifySharedMemoryConfigs({
      codex: renderCodexConfig("", good),
      gemini: renderGeminiConfig("{}", good),
      claude: renderClaudeConfig("{}", bad),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("same SQLite path"))).toBe(true);
  });

  it("fails when a config uses a relative database path", () => {
    const provider = buildKnowledgeGraphProvider("relative/shared-memory.db");
    const result = verifySharedMemoryConfigs({
      codex: renderCodexConfig("", provider),
      gemini: renderGeminiConfig("{}", provider),
      claude: renderClaudeConfig("{}", provider),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("absolute"))).toBe(true);
  });
});

describe("setup plan", () => {
  it("creates install actions only for missing CLIs", () => {
    const plan = buildSharedMemorySetupPlan({
      hasNode: true,
      hasCodex: true,
      hasGemini: false,
      hasClaude: false,
      dbPath: "/tmp/shared-memory.db",
    });

    expect(plan.installs).toEqual([
      "npm install -g @google/gemini-cli",
      "npm install -g @anthropic-ai/claude-code",
    ]);
    expect(plan.errors).toEqual([]);
  });

  it("fails fast when node is unavailable", () => {
    const plan = buildSharedMemorySetupPlan({
      hasNode: false,
      hasCodex: false,
      hasGemini: false,
      hasClaude: false,
      dbPath: "/tmp/shared-memory.db",
    });

    expect(plan.errors).toContain("Node.js 22+ is required for the installer.");
  });
});
