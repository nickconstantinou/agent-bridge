import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("systemd templates", () => {
  it("pin service-specific env files and absolute CLI paths", () => {
    const codex = readFileSync(new URL("../systemd/agent-bridge-codex.service", import.meta.url), "utf8");
    const gemini = readFileSync(new URL("../systemd/agent-bridge-gemini.service", import.meta.url), "utf8");

    expect(codex).toContain("EnvironmentFile=BRIDGE_HOME/agent-bridge/.env.codex");
    expect(gemini).toContain("EnvironmentFile=BRIDGE_HOME/agent-bridge/.env.gemini");
    expect(codex).toContain("BRIDGE_ENV_FILE=BRIDGE_HOME/agent-bridge/.env.codex");
    expect(gemini).toContain("BRIDGE_ENV_FILE=BRIDGE_HOME/agent-bridge/.env.gemini");
    expect(codex).toContain("User=BRIDGE_USER");
    expect(gemini).toContain("User=BRIDGE_USER");
    expect(codex).toContain('cd "${BRIDGE_PROJECT_DIR:?}" && exec ./node_modules/.bin/tsx src/index.ts');
    expect(gemini).toContain('cd "${BRIDGE_PROJECT_DIR:?}" && exec ./node_modules/.bin/tsx src/index.ts');

  });
});
