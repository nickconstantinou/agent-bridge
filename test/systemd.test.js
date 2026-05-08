import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("systemd templates", () => {
  it("pin service-specific env files and absolute CLI paths", () => {
    const codex = readFileSync(new URL("../systemd/agent-bridge-codex.service", import.meta.url), "utf8");
    const gemini = readFileSync(new URL("../systemd/agent-bridge-gemini.service", import.meta.url), "utf8");
    const codexEnv = readFileSync(new URL("../.env.codex", import.meta.url), "utf8");
    const geminiEnv = readFileSync(new URL("../.env.gemini", import.meta.url), "utf8");

    expect(codex).toContain("BRIDGE_ENV_FILE=/home/openclaw/.openclaw/workspace/projects/agent-bridge/.env.codex");
    expect(gemini).toContain("BRIDGE_ENV_FILE=/home/openclaw/.openclaw/workspace/projects/agent-bridge/.env.gemini");
    expect(codexEnv).toMatch(/^CODEX_COMMAND=\//m);
    expect(geminiEnv).toMatch(/^GEMINI_COMMAND=\//m);
  });
});
