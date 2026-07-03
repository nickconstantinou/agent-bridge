#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

tmp_file="$(mktemp)"
trap 'rm -f "$tmp_file"' EXIT

if grep -R --include='*.ts' -nE "from ['\"]vitest['\"]|from ['\"]node:test['\"]|(^|[^[:alnum:]_$])(describe|it|test)[[:space:]]*\(" src >"$tmp_file"; then
  cat "$tmp_file" >&2
  echo "arch-lint: test-only APIs must not be imported or called from src/" >&2
  exit 1
fi

echo "arch-lint: ok"
