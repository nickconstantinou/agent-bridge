#!/usr/bin/env node
// Advisor/conversation SQL ownership guard (Phase 4B, issue #135).
//
// advisor_calls/advisor_attempts/conversation_turns/conversation_summaries
// must only be referenced from their owning repository, the legacy baseline
// migration (which creates them), or a table reference textually inside a
// `.prepare(`/`.exec(` call whose immediately preceding, unbroken comment
// block carries an `arch-lint-allow-legacy-sql` marker.
//
// A table reference is proven to belong to a statement only if it falls
// within that statement's own character range — computed by tracking paren
// depth from the call's opening `(`, treating characters inside a backtick
// template literal as inert (so `COALESCE(...)`/subquery parens inside SQL
// don't confuse the depth count), until depth returns to 0. A reference
// outside every statement's range (e.g. in a separately declared SQL string
// assigned to a variable that's passed into `.prepare()` elsewhere) fails
// closed as unowned, rather than being attributed to the nearest preceding
// statement.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const OWNED_TABLES = /\b(advisor_calls|advisor_attempts|conversation_turns|conversation_summaries)\b/;
const STATEMENT_START = /\.(prepare|exec)\(/g;
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
 * Computes [startOffset, endOffset) character ranges (into the whole-file
 * string) for every `.prepare(`/`.exec(` call, by tracking paren depth from
 * the call's opening `(` and ignoring parens/backticks while inside a
 * template literal, until depth returns to 0.
 */
function findStatementRanges(content) {
  const ranges = [];
  STATEMENT_START.lastIndex = 0;
  let m;
  while ((m = STATEMENT_START.exec(content)) !== null) {
    const openParenIndex = m.index + m[0].length - 1; // index of the "(" itself
    let depth = 1;
    let inTemplate = false;
    let i = openParenIndex + 1;
    for (; i < content.length && depth > 0; i++) {
      const ch = content[i];
      if (ch === "\\" && inTemplate) {
        i++; // skip escaped char inside template
        continue;
      }
      if (ch === "`") {
        inTemplate = !inTemplate;
        continue;
      }
      if (inTemplate) continue;
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    ranges.push([openParenIndex, i]); // end is exclusive, one past the closing ")"
  }
  return ranges;
}

function offsetToLine(content, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

function statementIsMarked(lines, statementStartLine) {
  // statementStartLine is 1-indexed; walk backward through the contiguous
  // comment/blank-line block immediately above it.
  let j = statementStartLine - 2; // 0-indexed line just above the start line
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

function lintFile(filePath, relPath) {
  const violations = [];
  if (isOwnerFile(relPath)) return violations;
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const statementRanges = findStatementRanges(content);
  const markedStatementLines = new Set(
    statementRanges
      .map(([start]) => offsetToLine(content, start))
      .filter((line) => statementIsMarked(lines, line)),
  );

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!OWNED_TABLES.test(line)) continue;
    if (line.trim().startsWith("//")) continue; // prose mention, not executable SQL
    const lineNumber = i + 1;
    const matchOffset = lines.slice(0, i).join("\n").length + (i > 0 ? 1 : 0) + line.search(OWNED_TABLES);

    const containingStatement = statementRanges.find(
      ([start, end]) => matchOffset >= start && matchOffset < end,
    );
    if (containingStatement) {
      const statementStartLine = offsetToLine(content, containingStatement[0]);
      if (markedStatementLines.has(statementStartLine)) continue;
    }
    // Not proven to belong to any marked statement — fail closed.
    violations.push(`${relPath}:${lineNumber}:${line}`);
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
    "or be textually inside a .prepare()/.exec() call explicitly marked with " +
    "arch-lint-allow-legacy-sql immediately above",
  );
  for (const v of allViolations) console.error(v);
  process.exit(1);
}
process.exit(0);
