#!/usr/bin/env node
// Migration-primitive ownership guard (Phase 4C.2, issue #135).
//
// openDb/applyMigrations/applyMigrationsUpTo/applyLegacyCompatibleBaseline
// must only be referenced from their three defining files, and each file
// only through the exact primitive(s) the locked policy records for it:
//   - src/db.ts:                       may import applyMigrations only
//   - src/db/schema.ts:                may import applyLegacyCompatibleBaseline only
//   - src/db/legacyBaselineMigration.ts: may import none of the four
// (Each file may of course *define* its own primitive — that's a
// declaration, not an import, and this check only inspects import/export
// statements and dynamic import() calls.) Ownership is matched by exact
// repo-root-relative path equality, not a path suffix, so a nested
// "foo/src/db.ts" is never mistaken for the real owner file.
//
// Deny-by-default, not detect-then-allow: rather than trying to prove a
// namespace binding or dynamic import never reaches a primitive (which an
// AST-free regex check cannot do soundly — computed property access,
// destructuring off a dynamically-imported module, etc. all evade a
// property-access scan), any namespace import (`import * as ns`) or dynamic
// `import(...)` call naming a migration-owning module is an unconditional
// violation, and any wildcard re-export (`export *` / `export * as ns`) is
// too. No file in this codebase needs any of those three forms to reach a
// migration primitive today, so this has zero legitimate cost.
//
// Comments are stripped (length-preserving, so line numbers stay accurate)
// before matching, so a comment interleaved inside an import clause (e.g.
// `import { /* x */ openDb } from "./db.js"`) can't hide the identifier
// from the named-specifier check.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const PRIMITIVES = new Set([
  "openDb",
  "applyMigrations",
  "applyMigrationsUpTo",
  "applyLegacyCompatibleBaseline",
]);

// Exact repo-root-relative path -> the exact set of primitives that file may
// import (never a suffix match, never "everything").
const OWNER_IMPORT_ALLOWLIST = new Map([
  ["src/db.ts", new Set(["applyMigrations"])],
  ["src/db/schema.ts", new Set(["applyLegacyCompatibleBaseline"])],
  ["src/db/legacyBaselineMigration.ts", new Set()],
]);

const SENSITIVE_MODULE_SUFFIXES = ["db.js", "db/schema.js", "schema.js", "legacyBaselineMigration.js"];

// Matches `import`/`export` statements of the form:
//   import { a, b as c } from "spec";
//   import type { a } from "spec";
//   import * as ns from "spec";
//   export { a, b as c } from "spec";
//   export * from "spec";
//   export * as ns from "spec";
// The named-list/namespace/bare-star alternatives are tried in this order so
// "* as ns" (namespace) is preferred over the bare "*" (wildcard) branch.
const STATEMENT = /\b(import|export)\s+(type\s+)?(\*\s+as\s+(\w+)|\{([^}]*)\}|\*)\s+from\s+["']([^"']+)["']/g;

// `import("spec")` / `await import("spec")`, anywhere (not just at statement
// start), so a dynamic import used mid-expression is still caught.
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["'`]([^"'`]+)["'`]/g;

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

function isSensitiveModule(specifier) {
  return SENSITIVE_MODULE_SUFFIXES.some(
    (suffix) => specifier === `./${suffix}` || specifier.endsWith(`/${suffix}`),
  );
}

/** Strips // and /* *\/ comments, preserving length and newlines so offsets/line numbers stay valid. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function offsetToLine(content, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

function lintFile(filePath, relPath) {
  const violations = [];
  const permitted = OWNER_IMPORT_ALLOWLIST.get(relPath) ?? new Set();
  const rawContent = readFileSync(filePath, "utf8");
  const content = stripComments(rawContent);

  STATEMENT.lastIndex = 0;
  let m;
  while ((m = STATEMENT.exec(content)) !== null) {
    const [full, keyword, , , namespaceName, namedList, specifier] = m;
    if (!isSensitiveModule(specifier)) continue;
    const lineNumber = offsetToLine(content, m.index);

    if (namespaceName) {
      // Namespace import/re-export of a migration-owning module: always a
      // violation, regardless of owner status or downstream usage (see file
      // header). Nothing legitimate needs this form.
      const kind = keyword === "export" ? "wildcard namespace re-export" : "namespace import";
      violations.push(
        `${relPath}:${lineNumber}: ${kind} ("${full.trim()}") of a migration-owning module is not allowed — use a named import of only the specific permitted primitive`,
      );
      continue;
    }

    if (namedList !== undefined) {
      for (const rawSpecifier of namedList.split(",")) {
        const trimmed = rawSpecifier.trim();
        if (!trimmed) continue;
        // For `{ openDb as x }` the imported/exported name is the identifier
        // before `as`; for a bare `{ openDb }` it's the whole specifier.
        const importedName = trimmed.split(/\s+as\s+/)[0].trim().replace(/^type\s+/, "");
        if (!PRIMITIVES.has(importedName)) continue;
        if (keyword === "export") {
          violations.push(
            `${relPath}:${lineNumber}: re-export of "${importedName}" from a migration-owning module ("${specifier}") is not allowed`,
          );
        } else if (!permitted.has(importedName)) {
          violations.push(
            `${relPath}:${lineNumber}: import of "${importedName}" from "${specifier}" is not in this file's permitted primitive set (${
              permitted.size > 0 ? [...permitted].join(", ") : "none"
            })`,
          );
        }
      }
      continue;
    }

    // Bare `*` with no `as` binding only occurs as `export * from "sensitive"`
    // (a bare `import * from` isn't valid JS/TS) — a wildcard re-export.
    violations.push(
      `${relPath}:${lineNumber}: wildcard re-export ("export * from \\"${specifier}\\"") of a migration-owning module is not allowed`,
    );
  }

  DYNAMIC_IMPORT.lastIndex = 0;
  let dm;
  while ((dm = DYNAMIC_IMPORT.exec(content)) !== null) {
    if (!isSensitiveModule(dm[1])) continue;
    const lineNumber = offsetToLine(content, dm.index);
    violations.push(
      `${relPath}:${lineNumber}: dynamic import("${dm[1]}") of a migration-owning module is not allowed — use a named import of only the specific permitted primitive`,
    );
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
    "arch-lint: openDb/applyMigrations/applyMigrationsUpTo/applyLegacyCompatibleBaseline " +
    "must only be referenced from src/db.ts, src/db/schema.ts, and " +
    "src/db/legacyBaselineMigration.ts, each restricted to its own exact " +
    "permitted primitive set (issue #135, Phase 4C.2) — ordinary startup " +
    "code must use openProductionDb() instead",
  );
  for (const v of allViolations) console.error(v);
  process.exit(1);
}
process.exit(0);
