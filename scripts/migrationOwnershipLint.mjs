#!/usr/bin/env node
// Migration-primitive ownership guard (Phase 4C.2, issue #135).
//
// openDb/applyMigrations/applyMigrationsUpTo/applyLegacyCompatibleBaseline
// must only be referenced from their three defining files: src/db.ts (where
// openDb/openProductionDb are defined, and which imports applyMigrations to
// run it as part of their shared construction tail), src/db/schema.ts
// (defines applyMigrations/applyMigrationsUpTo), and
// src/db/legacyBaselineMigration.ts (defines applyLegacyCompatibleBaseline).
// Deny-by-default: every other src/ file is prohibited from reaching any of
// the four, by any means — a direct named import, an aliased import, a
// namespace import followed by property access, or a re-export (named or
// wildcard) — not just a literal `import { openDb }`.
//
// Module identity is matched by specifier suffix (e.g. a relative import
// ending in "db.js", "db/schema.js", or "legacyBaselineMigration.js"),
// mirroring scripts/sqlOwnershipLint.mjs's suffix-based owner-file matching,
// rather than real filesystem resolution — this keeps the check fixture-
// friendly (isolated test trees don't need a full src/ copy) and matches
// this repo's actual, consistent relative-import style.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const PRIMITIVES = new Set([
  "openDb",
  "applyMigrations",
  "applyMigrationsUpTo",
  "applyLegacyCompatibleBaseline",
]);

const OWNER_FILE_SUFFIXES = [
  "src/db.ts",
  "src/db/schema.ts",
  "src/db/legacyBaselineMigration.ts",
];

const SENSITIVE_MODULE_SUFFIXES = [
  "db.js",
  "db/schema.js",
  "schema.js",
  "legacyBaselineMigration.js",
];

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

function isSensitiveModule(specifier) {
  return SENSITIVE_MODULE_SUFFIXES.some(
    (suffix) => specifier === `./${suffix}` || specifier.endsWith(`/${suffix}`),
  );
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
  if (isOwnerFile(relPath)) return violations;
  const content = readFileSync(filePath, "utf8");
  const namespaceBindings = [];

  STATEMENT.lastIndex = 0;
  let m;
  while ((m = STATEMENT.exec(content)) !== null) {
    const [full, keyword, , , namespaceName, namedList, specifier] = m;
    if (!isSensitiveModule(specifier)) continue;
    const lineNumber = offsetToLine(content, m.index);

    if (namespaceName) {
      // `import * as ns from "sensitive"` / `export * as ns from "sensitive"`.
      // A namespace re-export unconditionally exposes every primitive under
      // that name; a namespace import only does if the binding is later
      // used to reach a primitive, checked in a second pass below.
      if (keyword === "export") {
        violations.push(
          `${relPath}:${lineNumber}: wildcard namespace re-export ("${full.trim()}") of a migration-owning module exposes all primitives`,
        );
      } else {
        namespaceBindings.push({ name: namespaceName, lineNumber });
      }
      continue;
    }

    if (namedList !== undefined) {
      for (const rawSpecifier of namedList.split(",")) {
        const trimmed = rawSpecifier.trim();
        if (!trimmed) continue;
        // For `{ openDb as x }` the imported/exported name is the identifier
        // before `as`; for a bare `{ openDb }` it's the whole specifier.
        const importedName = trimmed.split(/\s+as\s+/)[0].trim().replace(/^type\s+/, "");
        if (PRIMITIVES.has(importedName)) {
          violations.push(
            `${relPath}:${lineNumber}: ${keyword} of "${importedName}" from a migration-owning module ("${specifier}")`,
          );
        }
      }
      continue;
    }

    // Bare `*` with no `as` binding only occurs as `export * from "sensitive"`
    // (a bare `import * from` isn't valid JS/TS) — a wildcard re-export.
    violations.push(
      `${relPath}:${lineNumber}: wildcard re-export ("export * from \\"${specifier}\\"") of a migration-owning module exposes all primitives`,
    );
  }

  for (const { name, lineNumber } of namespaceBindings) {
    const usage = new RegExp(`\\b${name}\\.(${[...PRIMITIVES].join("|")})\\b`, "g");
    let usageMatch;
    while ((usageMatch = usage.exec(content)) !== null) {
      const usageLine = offsetToLine(content, usageMatch.index);
      violations.push(
        `${relPath}:${usageLine}: namespace access "${name}.${usageMatch[1]}" reaches a migration primitive imported as "${name}" (line ${lineNumber})`,
      );
    }
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
    "src/db/legacyBaselineMigration.ts (issue #135, Phase 4C.2) — ordinary " +
    "startup code must use openProductionDb() instead",
  );
  for (const v of allViolations) console.error(v);
  process.exit(1);
}
process.exit(0);
