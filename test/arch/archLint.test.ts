import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(__dirname, "..", "..", "scripts", "arch-lint.sh");

function runLint(dir: string): { code: number; output: string } {
  try {
    const output = execFileSync("bash", [SCRIPT, dir], { encoding: "utf8" });
    return { code: 0, output };
  } catch (err: any) {
    return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("arch-lint", () => {
  it("is executable", () => {
    accessSync(SCRIPT, constants.X_OK);
  });

  it("passes on a src tree without test-only APIs", () => {
    const dir = mkdtempSync(join(tmpdir(), "archlint-clean-"));
    try {
      writeFileSync(join(dir, "ok.ts"), 'import { readFileSync } from "node:fs";\nexport const x = 1;\n');
      expect(runLint(dir).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when src imports vitest", () => {
    const dir = mkdtempSync(join(tmpdir(), "archlint-vitest-"));
    try {
      writeFileSync(join(dir, "bad.ts"), 'import { describe } from "vitest";\n');
      const res = runLint(dir);
      expect(res.code).not.toBe(0);
      expect(res.output).toContain("arch-lint: test-only APIs must not be imported or called from src/");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when src imports node:test", () => {
    const dir = mkdtempSync(join(tmpdir(), "archlint-nodetest-"));
    try {
      writeFileSync(join(dir, "bad.ts"), 'import test from "node:test";\n');
      expect(runLint(dir).code).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when src calls describe/it/test", () => {
    const dir = mkdtempSync(join(tmpdir(), "archlint-calls-"));
    try {
      mkdirSync(join(dir, "nested"));
      writeFileSync(join(dir, "nested", "bad.ts"), 'describe("x", () => {});\n');
      expect(runLint(dir).code).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes on the real src/ tree", () => {
    expect(runLint(join(__dirname, "..", "..", "src")).code).toBe(0);
  });
});
