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
    expect(codex).toContain('export PATH="$(dirname "${NODE_BIN:?}"):$PATH"');
    expect(antigravity).toContain('export PATH="$(dirname "${NODE_BIN:?}"):$PATH"');
    expect(codex).toContain('cd "${BRIDGE_PROJECT_DIR:?}" && exec "${NODE_BIN:?}" ./node_modules/tsx/dist/cli.mjs src/index.ts');
    expect(antigravity).toContain('cd "${BRIDGE_PROJECT_DIR:?}" && exec "${NODE_BIN:?}" ./node_modules/tsx/dist/cli.mjs src/index.ts');
  });

  it("all service templates load shared env file before bot-specific", () => {
    const codex = readFileSync(new URL("../systemd/agent-bridge-codex.service", import.meta.url), "utf8");
    const antigravity = readFileSync(new URL("../systemd/agent-bridge-antigravity.service", import.meta.url), "utf8");
    const claude = readFileSync(new URL("../systemd/agent-bridge-claude.service", import.meta.url), "utf8");

    for (const [name, content] of [["codex", codex], ["antigravity", antigravity], ["claude", claude]] as const) {
      expect(content, name).toContain("EnvironmentFile=-/etc/default/agent-bridge-shared");
      const sharedIdx = content.indexOf("EnvironmentFile=-/etc/default/agent-bridge-shared");
      const specificIdx = content.indexOf(`EnvironmentFile=/etc/default/agent-bridge-${name}`);
      expect(sharedIdx, `${name}: shared before specific`).toBeLessThan(specificIdx);
    }
  });

  it(".env.shared.example exists with shared vars", () => {
    const shared = readFileSync(new URL("../.env.shared.example", import.meta.url), "utf8");
    expect(shared).toContain("HEALTH_MONITOR_ENABLED");
    expect(shared).toContain("TELEGRAM_ALLOWED_USER_IDS");
    expect(shared).toContain("BRIDGE_ROOT_DIR");
    expect(shared).toContain("NODE_BIN");
  });

  it("all service templates include KillMode=control-group", () => {
    const codex = readFileSync(new URL("../systemd/agent-bridge-codex.service", import.meta.url), "utf8");
    const antigravity = readFileSync(new URL("../systemd/agent-bridge-antigravity.service", import.meta.url), "utf8");
    const claude = readFileSync(new URL("../systemd/agent-bridge-claude.service", import.meta.url), "utf8");
    expect(codex).toContain("KillMode=control-group");
    expect(antigravity).toContain("KillMode=control-group");
    expect(claude).toContain("KillMode=control-group");
  });

  it("requires and records Node 24+ for service runtime", () => {
    const install = readFileSync(new URL("../scripts/install.sh", import.meta.url), "utf8");
    const deployment = readFileSync(new URL("../scripts/upgrade.sh", import.meta.url), "utf8");

    expect(install).toContain("NODE_MIN_MAJOR=24");
    expect(install).toContain("NODE_BIN=${NODE_BIN}");
    expect(install).toContain('"${NODE_BIN}" ./node_modules/tsx/dist/cli.mjs');
    expect(deployment).toContain("NODE_MIN_MAJOR=24");
    expect(deployment).toContain("NODE_BIN=${NODE_BIN}");
    expect(deployment).toContain('"${NODE_BIN}" ./node_modules/tsx/dist/cli.mjs');
  });

  it("deployment update mode skips npm build when package has no build script", () => {
    const deployment = readFileSync(new URL("../scripts/upgrade.sh", import.meta.url), "utf8");

    expect(deployment).toContain("npm install --include=dev");
    expect(deployment).toContain("npm run | grep -q");
    expect(deployment).toContain("[update] No build script; skipping build");
  });

  it("deployment does not write retired Telegram Markdown IR defaults", () => {
    const deployment = readFileSync(new URL("../scripts/upgrade.sh", import.meta.url), "utf8");

    expect(deployment).not.toContain("ensure_markdown_ir_default");
    expect(deployment).not.toContain("TELEGRAM_MARKDOWN_IR_ENABLED");
  });
});
