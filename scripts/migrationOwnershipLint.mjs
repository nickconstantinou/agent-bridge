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
// This walks the real TypeScript AST (via the `typescript` compiler API,
// already a project dependency) rather than pattern-matching source text.
// Two prior regex-based iterations were each shown to be bypassable:
//   - A regex "does this look like a comment" pass blanked `/*`/`*/`
//     *inside string literals* (e.g. `const marker = "/*";`), which could
//     blank out a real import statement before the import regex ran.
//   - A regex dynamic-import check only matched a literal quote/backtick
//     immediately after `import(`, so `import(someVariable)` passed
//     undetected.
// A real parser distinguishes string-literal contents from actual comments
// and from actual call-expression arguments by construction, closing both
// classes of bypass rather than patching individual examples of them.
//
// Deny-by-default, not detect-then-allow: any namespace import
// (`import * as ns`) or wildcard re-export naming a migration-owning module
// is an unconditional violation regardless of downstream usage — no file in
// this codebase needs either form to reach a primitive. Any dynamic
// `import(...)` naming a migration-owning module (by string-literal
// specifier) is also unconditional. A dynamic `import(...)` whose specifier
// is NOT a string literal (a variable, template expression, concatenation,
// etc.) is rejected outright under production src/ — its target cannot be
// statically proven to avoid a migration-owning module, so it fails closed
// rather than being allowed through unresolved.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

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

/** The bound/imported/exported name — the identifier before `as`, or the name itself. */
function elementName(el) {
  return (el.propertyName ?? el.name).text;
}

function lintFile(filePath, relPath) {
  const violations = [];
  const permitted = OWNER_IMPORT_ALLOWLIST.get(relPath) ?? new Set();
  const text = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  function lineOf(node) {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  }

  function visit(node) {
    // Static `import ... from "spec"` (including `import type`).
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (isSensitiveModule(specifier)) {
        const lineNumber = lineOf(node);
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          violations.push(
            `${relPath}:${lineNumber}: namespace import ("import * as ${bindings.name.text} from \\"${specifier}\\"") of a migration-owning module is not allowed — use a named import of only the specific permitted primitive`,
          );
        } else if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            const importedName = elementName(el);
            if (!PRIMITIVES.has(importedName)) continue;
            if (!permitted.has(importedName)) {
              violations.push(
                `${relPath}:${lineNumber}: import of "${importedName}" from "${specifier}" is not in this file's permitted primitive set (${
                  permitted.size > 0 ? [...permitted].join(", ") : "none"
                })`,
              );
            }
          }
        }
      }
    }

    // `export { a, b as c } from "spec"`, `export * from "spec"`,
    // `export * as ns from "spec"`.
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (isSensitiveModule(specifier)) {
        const lineNumber = lineOf(node);
        const clause = node.exportClause;
        if (!clause) {
          violations.push(
            `${relPath}:${lineNumber}: wildcard re-export ("export * from \\"${specifier}\\"") of a migration-owning module is not allowed`,
          );
        } else if (ts.isNamespaceExport(clause)) {
          violations.push(
            `${relPath}:${lineNumber}: wildcard namespace re-export ("export * as ${clause.name.text} from \\"${specifier}\\"") of a migration-owning module is not allowed`,
          );
        } else if (ts.isNamedExports(clause)) {
          for (const el of clause.elements) {
            const exportedName = elementName(el);
            if (!PRIMITIVES.has(exportedName)) continue;
            violations.push(
              `${relPath}:${lineNumber}: re-export of "${exportedName}" from a migration-owning module ("${specifier}") is not allowed`,
            );
          }
        }
      }
    }

    // Dynamic `import(...)` call expressions, anywhere in an expression.
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const lineNumber = lineOf(node);
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) {
        if (isSensitiveModule(arg.text)) {
          violations.push(
            `${relPath}:${lineNumber}: dynamic import("${arg.text}") of a migration-owning module is not allowed — use a named import of only the specific permitted primitive`,
          );
        }
      } else {
        // Non-literal specifier (variable, template expression,
        // concatenation, ...): its target cannot be statically verified to
        // avoid a migration-owning module, so it fails closed rather than
        // being allowed through unresolved.
        violations.push(
          `${relPath}:${lineNumber}: dynamic import() with a non-literal specifier is not allowed under production src/ — the target cannot be statically verified to avoid migration-owning modules`,
        );
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
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
