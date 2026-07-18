#!/usr/bin/env node
// Advisor/conversation SQL ownership guard (Phase 4B, issue #135).
//
// advisor_calls/advisor_attempts/conversation_turns/conversation_summaries
// must only be referenced from their owning repository, the legacy baseline
// migration (which creates them), or a statement whose *immediately
// preceding* comment block (no other code between) contains an
// `arch-lint-allow-legacy-sql` marker. The marker is resolved per-statement
// (the nearest enclosing `.prepare(`/`.exec(` call), not by a fixed line
// window — a window can let an unrelated, unmarked statement a few lines
// away slip through as if it were the marked one.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const OWNED_TABLES = /\b(advisor_calls|advisor_attempts|conversation_turns|conversation_summaries)\b/;
const STATEMENT_START = /\.(prepare|exec)\(/;
const MARKER = "arch-lint-allow-legacy-sql";
const OWNER_FILE_SUFFIXES = [
  "src/repositories/advisorRepository.ts",
  "src/repositories/conversationRepository.ts",
  "src/db/legacyBaselineMigration.ts",
];

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFiles(full));
    else if (/\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

function isOwnerFile(relPath) {
  return OWNER_FILE_SUFFIXES.some((suffix) => relPath === suffix || relPath.endsWith(`/${suffix}`));
}

/**
 * For each line, find the nearest enclosing statement-start line (the
 * closest `.prepare(`/`.exec(` at or before it), then walk backward from
 * that statement-start through a *contiguous* run of comment/blank lines
 * only — stopping at the first line that is neither — and check whether
 * the marker appears in that contiguous run. This binds the marker to
 * exactly the statement it sits directly above.
 */
function statementIsMarked(lines, statementStartIndex) {
  let j = statementStartIndex - 1;
  while (j >= 0) {
    const trimmed = lines[j].trim();
    if (trimmed.startsWith("//")) {
      if (trimmed.includes(MARKER)) return true;
      j--;
      continue;
    }
    if (trimmed === "") {
      j--;
      continue;
    }
    break;
  }
  return false;
}

function findEnclosingStatementStart(lines, matchIndex) {
  for (let i = matchIndex; i >= 0; i--) {
    if (STATEMENT_START.test(lines[i])) return i;
  }
  return -1;
}

function lintFile(filePath, relPath) {
  const violations = [];
  if (isOwnerFile(relPath)) return violations;
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!OWNED_TABLES.test(line)) continue;
    if (line.trim().startsWith("//")) continue; // prose mention, not executable SQL
    const statementStart = findEnclosingStatementStart(lines, i);
    if (statementStart !== -1 && statementIsMarked(lines, statementStart)) continue;
    violations.push(`${relPath}:${i + 1}:${line}`);
  }
  return violations;
}

const targetDir = process.argv[2] || "src";
const files = listFiles(targetDir);
const allViolations = [];
for (const file of files) {
  const relPath = relative(process.cwd(), file);
  allViolations.push(...lintFile(file, relPath));
}

if (allViolations.length > 0) {
  console.error(
    "arch-lint: advisor/conversation SQL must live in its owning repository " +
    "(src/repositories/advisorRepository.ts, src/repositories/conversationRepository.ts) " +
    "or be explicitly marked with arch-lint-allow-legacy-sql immediately above the statement",
  );
  for (const v of allViolations) console.error(v);
  process.exit(1);
}
process.exit(0);
