#!/usr/bin/env bash
# Architecture lint guard (Epic 11, issue #52).
# Fails when production code under src/ imports or calls test-only APIs.
# Raw SQLite boundary enforcement is intentionally deferred (see issue #52).
set -euo pipefail

TARGET_DIR="${1:-src}"

if [ ! -d "$TARGET_DIR" ]; then
  echo "arch-lint: directory not found: $TARGET_DIR" >&2
  exit 2
fi

violations=$(grep -rnE \
  -e 'from "vitest"' \
  -e "from 'vitest'" \
  -e 'from "node:test"' \
  -e "from 'node:test'" \
  -e 'require\(["'"'"']vitest["'"'"']\)' \
  -e 'require\(["'"'"']node:test["'"'"']\)' \
  -e '^\s*(describe|it|test)\(' \
  --include='*.ts' --include='*.js' --include='*.mjs' --include='*.cjs' \
  "$TARGET_DIR" || true)

if [ -n "$violations" ]; then
  echo "arch-lint: test-only APIs must not be imported or called from src/" >&2
  echo "$violations" >&2
  exit 1
fi

echo "arch-lint: ok ($TARGET_DIR)"
