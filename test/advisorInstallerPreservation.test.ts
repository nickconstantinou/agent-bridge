import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "advisor-installer-"));
  dirs.push(dir);
  return dir;
}

function extract(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

function runBash(script: string, cwd: string): void {
  const result = spawnSync("bash", ["-c", script], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("advisor installer preservation", () => {
  const installer = readFileSync("scripts/install.sh", "utf8");
  const envHelpers = extract(
    installer,
    "env_file_get()",
    'seed_from_env_file "${REPO_DIR}/.env.shared"',
  );
  const optionalWriter = extract(
    installer,
    "write_optional_env()",
    "# Write shared defaults loaded by all services",
  );

  it("remains valid bash", () => {
    const result = spawnSync("bash", ["-n", "scripts/install.sh"], { encoding: "utf8" });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it("does not copy advisor example defaults into a fresh generated environment", () => {
    const dir = tempDir();
    const example = join(dir, "example");
    const target = join(dir, "target");
    writeFileSync(example, [
      "# advisor defaults",
      "BRIDGE_ADVISOR_ENABLED=true",
      "BRIDGE_ADVISOR_MODE=manual",
      "BRIDGE_ADVISOR_CHAIN=claude:example,codex:example",
      "POLL_INTERVAL_MS=1000",
      "",
    ].join("\n"));

    runBash(`${envHelpers}\nwrite_env_file "${example}" "${target}"`, dir);

    const generated = readFileSync(target, "utf8");
    expect(generated).toContain("# advisor defaults");
    expect(generated).toContain("POLL_INTERVAL_MS=1000");
    expect(generated).not.toContain("BRIDGE_ADVISOR_ENABLED=");
    expect(generated).not.toContain("BRIDGE_ADVISOR_CHAIN=");
  });

  it("preserves explicit false and an intentionally blank chain through upgrade output", () => {
    const dir = tempDir();
    const existing = join(dir, "existing");
    const example = join(dir, "example");
    const target = join(dir, "target");
    const defaults = join(dir, "defaults");
    writeFileSync(existing, [
      "BRIDGE_ADVISOR_ENABLED=false",
      "BRIDGE_ADVISOR_MODE=manual",
      "BRIDGE_ADVISOR_CHAIN=",
      "BRIDGE_ADVISOR_MAX_CALLS_PER_TURN=1",
      "",
    ].join("\n"));
    writeFileSync(example, [
      "BRIDGE_ADVISOR_ENABLED=true",
      "BRIDGE_ADVISOR_MODE=manual",
      "BRIDGE_ADVISOR_CHAIN=claude:example,codex:example",
      "BRIDGE_ADVISOR_MAX_CALLS_PER_TURN=5",
      "",
    ].join("\n"));

    runBash([
      envHelpers,
      optionalWriter,
      `seed_from_env_file "${existing}"`,
      `write_env_file "${example}" "${target}"`,
      `{ for key in BRIDGE_ADVISOR_ENABLED BRIDGE_ADVISOR_MODE BRIDGE_ADVISOR_CHAIN BRIDGE_ADVISOR_MAX_CALLS_PER_TURN; do write_optional_env "\${key}"; done; } > "${defaults}"`,
    ].join("\n"), dir);

    for (const output of [readFileSync(target, "utf8"), readFileSync(defaults, "utf8")]) {
      expect(output).toContain("BRIDGE_ADVISOR_ENABLED=false");
      expect(output).toContain("BRIDGE_ADVISOR_MODE=manual");
      expect(output).toContain("BRIDGE_ADVISOR_CHAIN=\n");
      expect(output).toContain("BRIDGE_ADVISOR_MAX_CALLS_PER_TURN=1");
      expect(output).not.toContain("claude:example");
    }
  });

  it("writes advisor variables to shared defaults only through explicit-set checks", () => {
    expect(installer).toContain("for key in BRIDGE_ADVISOR_ENABLED BRIDGE_ADVISOR_MODE BRIDGE_ADVISOR_CHAIN");
    expect(installer).toContain('write_optional_env "${key}"');
    expect(installer).not.toContain("BRIDGE_ADVISOR_ENABLED=${BRIDGE_ADVISOR_ENABLED:-true}");
    expect(installer).not.toContain("BRIDGE_ADVISOR_CHAIN=${BRIDGE_ADVISOR_CHAIN:-");
  });
});
