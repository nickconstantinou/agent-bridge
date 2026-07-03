#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() {
  echo "arch-lint: $1" >&2
  exit 1
}

if grep -R --include='*.ts' -nE "from ['\"]vitest['\"]|from ['\"]node:test['\"]|describe\(|it\(|test\(" src >/tmp/agent-bridge-arch-lint-vitest.txt; then
  cat /tmp/agent-bridge-arch-lint-vitest.txt >&2
  fail "test-only APIs must not be imported or called from src/"
fi

if grep -R --include='*.ts' -nE "\.prepare\(" src \
  | grep -vE "src/db\.ts:|src/repositories/" \
  >/tmp/agent-bridge-arch-lint-sql.txt; then
  cat /tmp/agent-bridge-arch-lint-sql.txt >&2
  fail "raw SQLite prepare() calls must stay inside src/db.ts or src/repositories/"
fi

echo "arch-lint: ok"
