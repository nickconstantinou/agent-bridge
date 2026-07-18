import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectAdvisorConfigSources } from "../src/advisorConfigSource.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "advisor-config-source-"));
  dirs.push(dir);
  return dir;
}

function write(path: string, lines: string[]): void {
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("advisor configuration source diagnostics", () => {
  it("reports the systemd shared file as authoritative when it matches the effective chain", () => {
    const dir = tempDir();
    const repo = join(dir, ".env.shared");
    const systemd = join(dir, "agent-bridge-shared");
    const lines = [
      "BRIDGE_ADVISOR_ENABLED=true",
      "BRIDGE_ADVISOR_MODE=manual",
      "BRIDGE_ADVISOR_CHAIN=claude:fable,codex:sol",
    ];
    write(repo, lines);
    write(systemd, lines);

    const result = inspectAdvisorConfigSources({
      env: { BRIDGE_ADVISOR_CHAIN: "claude:fable,codex:sol" },
      repoEnvPath: repo,
      systemdEnvPath: systemd,
    });

    expect(result.effectiveChainSource).toBe(systemd);
    expect(result.driftKeys).toEqual([]);
  });

  it("detects conflicting values without returning either file's values", () => {
    const dir = tempDir();
    const repo = join(dir, ".env.shared");
    const systemd = join(dir, "agent-bridge-shared");
    write(repo, [
      "BRIDGE_ADVISOR_ENABLED=true",
      "BRIDGE_ADVISOR_CHAIN=claude:new",
    ]);
    write(systemd, [
      "BRIDGE_ADVISOR_ENABLED=false",
      "BRIDGE_ADVISOR_CHAIN=claude:old",
    ]);

    const result = inspectAdvisorConfigSources({
      env: { BRIDGE_ADVISOR_CHAIN: "claude:old" },
      repoEnvPath: repo,
      systemdEnvPath: systemd,
    });

    expect(result.effectiveChainSource).toBe(systemd);
    expect(result.driftKeys).toEqual([
      "BRIDGE_ADVISOR_ENABLED",
      "BRIDGE_ADVISOR_CHAIN",
    ]);
    expect(result).not.toHaveProperty("repoValues");
    expect(result).not.toHaveProperty("systemdValues");
  });

  it("does not warn when only the repository source is readable", () => {
    const dir = tempDir();
    const repo = join(dir, ".env.shared");
    write(repo, ["BRIDGE_ADVISOR_CHAIN=claude:fable"]);

    const result = inspectAdvisorConfigSources({
      env: { BRIDGE_ADVISOR_CHAIN: "claude:fable" },
      repoEnvPath: repo,
      systemdEnvPath: join(dir, "missing-systemd"),
    });

    expect(result.repoReadable).toBe(true);
    expect(result.systemdReadable).toBe(false);
    expect(result.effectiveChainSource).toBe(repo);
    expect(result.driftKeys).toEqual([]);
  });

  it("treats unreadable sources as unavailable rather than configuration drift", () => {
    const dir = tempDir();
    const result = inspectAdvisorConfigSources({
      env: { BRIDGE_ADVISOR_CHAIN: "claude:runtime" },
      repoEnvPath: join(dir, "missing-repo"),
      systemdEnvPath: join(dir, "missing-systemd"),
    });

    expect(result.repoReadable).toBe(false);
    expect(result.systemdReadable).toBe(false);
    expect(result.effectiveChainSource).toBe("process environment or bot-specific override");
    expect(result.driftKeys).toEqual([]);
  });

  it("supports quoted values and reports an unconfigured built-in source", () => {
    const dir = tempDir();
    const repo = join(dir, ".env.shared");
    const systemd = join(dir, "agent-bridge-shared");
    write(repo, ["BRIDGE_ADVISOR_CHAIN=\"claude:fable\""]);
    write(systemd, ["BRIDGE_ADVISOR_CHAIN='claude:fable'"]);

    const matching = inspectAdvisorConfigSources({
      env: { BRIDGE_ADVISOR_CHAIN: "claude:fable" },
      repoEnvPath: repo,
      systemdEnvPath: systemd,
    });
    expect(matching.driftKeys).toEqual([]);

    const unconfigured = inspectAdvisorConfigSources({
      env: {},
      repoEnvPath: join(dir, "missing-repo"),
      systemdEnvPath: join(dir, "missing-systemd"),
    });
    expect(unconfigured.effectiveChainSource).toBe("built-in default / unconfigured");
  });
});
