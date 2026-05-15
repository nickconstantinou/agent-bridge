import { describe, expect, it } from "vitest";
import {
  defaultAgentMemoryDbPath,
  defaultAgentMemoryWrapperPath,
  getSharedMemoryHomeDir,
  renderAgentMemoryInstructionFile,
  renderAgentMemoryWrapperScript,
  verifySharedMemoryConfigs,
} from "../src/sharedMemory.js";

describe("agent memory instructions", () => {
  it("uses stable defaults under the home directory", () => {
    expect(defaultAgentMemoryDbPath("/home/tester")).toBe("/home/tester/.agent-bridge/shared-memory/agent-memory.sqlite");
    expect(defaultAgentMemoryWrapperPath("/home/tester")).toBe("/home/tester/.local/bin/agent-memory");
  });

  it("prefers an explicit shared-memory home over HOME", () => {
    const home = getSharedMemoryHomeDir({ SHARED_MEMORY_HOME: "/home/openclaw", HOME: "/root" });
    expect(home).toBe("/home/openclaw");
  });

  it("renders a managed instruction block", () => {
    const rendered = renderAgentMemoryInstructionFile("", "codex", "/tmp/agent-memory.sqlite");
    expect(rendered).toContain("agent-memory recall");
    expect(rendered).toContain("Do not rely on MCP for memory.");
  });

  it("renders a shell wrapper that calls npm run agent-memory", () => {
    const rendered = renderAgentMemoryWrapperScript({ repoRoot: "/repo" });
    expect(rendered).toContain("npm run agent-memory");
  });
});

describe("verification", () => {
  it("accepts instruction blocks in all three files", () => {
    const block = renderAgentMemoryInstructionFile("", "claude", "/tmp/agent-memory.sqlite");
    const result = verifySharedMemoryConfigs({ codex: block, gemini: block, claude: block });
    expect(result.ok).toBe(true);
  });
});
