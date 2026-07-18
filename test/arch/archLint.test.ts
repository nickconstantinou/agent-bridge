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

  it("fails when a non-owner file queries an advisor/conversation table directly", () => {
    const dir = mkdtempSync(join(tmpdir(), "archlint-sql-owner-"));
    try {
      writeFileSync(
        join(dir, "bad.ts"),
        'export function f(db: any) {\n  return db.prepare(`SELECT * FROM conversation_turns WHERE chat_key = ?`).all("x");\n}\n',
      );
      const res = runLint(dir);
      expect(res.code).not.toBe(0);
      expect(res.output).toContain("advisor/conversation SQL must live in its owning repository");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes when the SQL is preceded by an arch-lint-allow-legacy-sql marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "archlint-sql-allowed-"));
    try {
      writeFileSync(
        join(dir, "ok.ts"),
        [
          "export function f(db: any) {",
          "  // arch-lint-allow-legacy-sql: deliberate documented exception",
          "  return db.prepare(`SELECT * FROM conversation_turns WHERE chat_key = ?`).all(\"x\");",
          "}",
          "",
        ].join("\n"),
      );
      expect(runLint(dir).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when a non-owner file queries an advisor_calls table directly", () => {
    const dir = mkdtempSync(join(tmpdir(), "archlint-sql-advisor-"));
    try {
      writeFileSync(
        join(dir, "bad.ts"),
        'export function f(db: any) {\n  return db.prepare(`SELECT * FROM advisor_calls WHERE request_id = ?`).get("x");\n}\n',
      );
      const res = runLint(dir);
      expect(res.code).not.toBe(0);
      expect(res.output).toContain("advisor/conversation SQL must live in its owning repository");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a comment-only mention of a conversation table name", () => {
    const dir = mkdtempSync(join(tmpdir(), "archlint-sql-comment-"));
    try {
      writeFileSync(
        join(dir, "ok.ts"),
        "// this note just mentions conversation_turns in prose, not SQL\nexport const x = 1;\n",
      );
      expect(runLint(dir).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
