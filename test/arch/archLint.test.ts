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

  it("does not let a marker exempt a nearby unmarked statement (no leakage)", () => {
    // Regression test: an earlier version of this check looked back a fixed
    // 15-line window for the marker, so a second, unmarked statement placed
    // shortly after a legitimately marked one would incorrectly pass. The
    // marker must bind to exactly the statement it sits directly above.
    const dir = mkdtempSync(join(tmpdir(), "archlint-sql-leak-"));
    try {
      writeFileSync(
        join(dir, "bad.ts"),
        [
          "export function marked(db: any) {",
          "  // arch-lint-allow-legacy-sql: deliberate documented exception",
          "  return db.prepare(`SELECT * FROM conversation_turns WHERE chat_key = ?`).all(\"x\");",
          "}",
          "",
          "export function unmarked(db: any) {",
          "  return db.prepare(`SELECT * FROM conversation_summaries WHERE chat_key = ?`).all(\"x\");",
          "}",
          "",
        ].join("\n"),
      );
      const res = runLint(dir);
      expect(res.code).not.toBe(0);
      expect(res.output).toContain("conversation_summaries");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not attribute a separately declared SQL string to an earlier marked statement (fails closed)", () => {
    // Regression test: a marker must prove the table reference is textually
    // inside its own .prepare()/.exec() call, not just "somewhere after a
    // marked statement and before the next one." A SQL string built in a
    // variable and passed to .prepare() later must not inherit an earlier
    // marked call's exemption — the reference here isn't inside any
    // .prepare()/.exec() call's own parentheses at all.
    const dir = mkdtempSync(join(tmpdir(), "archlint-sql-separate-string-"));
    try {
      writeFileSync(
        join(dir, "bad.ts"),
        [
          "export function f(db: any) {",
          "  // arch-lint-allow-legacy-sql: legitimate exception",
          "  db.prepare(`SELECT * FROM conversation_turns`).all();",
          "",
          "  const leakedSql = `SELECT * FROM conversation_summaries`;",
          "  return db.prepare(leakedSql).all();",
          "}",
          "",
        ].join("\n"),
      );
      const res = runLint(dir);
      expect(res.code).not.toBe(0);
      expect(res.output).toContain("conversation_summaries");
      expect(res.output).toContain("leakedSql");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("catches a second unowned reference sharing a line with a marked statement", () => {
    // Regression test: the check must inspect every owned-table occurrence
    // on a line, not just the first (an earlier version used
    // line.search(), which only finds the first match). A marked statement
    // followed on the SAME line by an unrelated, unmarked SQL string
    // assignment must still be caught.
    const dir = mkdtempSync(join(tmpdir(), "archlint-sql-same-line-string-"));
    try {
      writeFileSync(
        join(dir, "bad.ts"),
        [
          "export function f(db: any) {",
          "  // arch-lint-allow-legacy-sql: legitimate exception",
          "  db.prepare(`SELECT * FROM conversation_turns`).all(); const leakedSql = `SELECT * FROM conversation_summaries`;",
          "  return db.prepare(leakedSql).all();",
          "}",
          "",
        ].join("\n"),
      );
      const res = runLint(dir);
      expect(res.code).not.toBe(0);
      expect(res.output).toContain("conversation_summaries");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed for two statements sharing a single marked line (ambiguous attribution)", () => {
    // Regression test: a marker precedes a LINE, not a specific call. If
    // two .prepare()/.exec() statements both start on that line, the
    // marker can't be unambiguously attributed to just one of them — both
    // must be treated as unmarked (fail closed) rather than both being
    // exempted.
    const dir = mkdtempSync(join(tmpdir(), "archlint-sql-two-calls-one-line-"));
    try {
      writeFileSync(
        join(dir, "bad.ts"),
        [
          "export function f(db: any) {",
          "  // arch-lint-allow-legacy-sql: legitimate exception",
          "  db.prepare(`SELECT * FROM conversation_turns`).all(); db.prepare(`SELECT * FROM conversation_summaries`).all();",
          "}",
          "",
        ].join("\n"),
      );
      const res = runLint(dir);
      expect(res.code).not.toBe(0);
      expect(res.output).toContain("conversation_turns");
      expect(res.output).toContain("conversation_summaries");
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
