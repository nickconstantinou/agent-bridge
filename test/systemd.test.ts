import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("systemd templates", () => {
  it("pin service-specific env files and absolute CLI paths", () => {
    const codex = readFileSync(new URL("../systemd/agent-bridge-codex.service", import.meta.url), "utf8");
    const antigravity = readFileSync(new URL("../systemd/agent-bridge-antigravity.service", import.meta.url), "utf8");

    expect(codex).toContain("EnvironmentFile=/etc/default/agent-bridge-codex");
    expect(antigravity).toContain("EnvironmentFile=/etc/default/agent-bridge-antigravity");
    expect(codex).toContain("User=BRIDGE_USER");
    expect(antigravity).toContain("User=BRIDGE_USER");
    expect(codex).toContain('cd "${BRIDGE_PROJECT_DIR:?}" && exec ./node_modules/.bin/tsx src/index.ts');
    expect(antigravity).toContain('cd "${BRIDGE_PROJECT_DIR:?}" && exec ./node_modules/.bin/tsx src/index.ts');
  });
});
