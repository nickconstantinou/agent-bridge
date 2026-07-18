#!/usr/bin/env bash
# Architecture lint guard (Epic 11, issue #52).
# Fails when production code under src/ imports or calls test-only APIs.
# General raw SQLite boundary enforcement is intentionally deferred (see
# issue #52); the advisor_calls/advisor_attempts and
# conversation_turns/conversation_summaries tables are a narrow, Phase 4B
# exception (see issue #135) — their SQL is confined to the repository files
# that own them, plus the legacy baseline migration that creates them and one
# explicitly marked non-schema maintenance statement in src/db.ts.
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

# Advisor/conversation SQL ownership guard (Phase 4B, issue #135): the tables
# below must only be referenced from their owning repository, the legacy
# baseline migration (which creates them), or a line immediately preceded by
# an explicit `arch-lint-allow-legacy-sql` marker comment justifying a
# deliberate exception (currently: the startup conversation-turn prune in
# openDb(), which is runtime maintenance, not a repository operation).
sql_owned_tables='advisor_calls|advisor_attempts|conversation_turns|conversation_summaries'
sql_owner_files='src/repositories/advisorRepository.ts|src/repositories/conversationRepository.ts|src/db/legacyBaselineMigration.ts'

sql_violations=""
while IFS= read -r match; do
  [ -z "$match" ] && continue
  file="${match%%:*}"
  rest="${match#*:}"
  line="${rest%%:*}"
  if echo "$file" | grep -qE "$sql_owner_files"; then
    continue
  fi
  matched_line_content=$(sed -n "${line}p" "$file" 2>/dev/null || true)
  trimmed=$(echo "$matched_line_content" | sed -E 's/^[[:space:]]*//')
  if echo "$trimmed" | grep -qE '^//'; then
    continue
  fi
  # Look back up to 15 lines for the marker, to cover a multi-line template
  # literal statement where the marker sits above the `.exec(`/`.prepare(`
  # call, not immediately above every line the table name appears on.
  context_start=$((line - 15))
  [ "$context_start" -lt 1 ] && context_start=1
  marker=$(sed -n "${context_start},${line}p" "$file" 2>/dev/null || true)
  if echo "$marker" | grep -q 'arch-lint-allow-legacy-sql'; then
    continue
  fi
  sql_violations="${sql_violations}${match}"$'\n'
done <<< "$(grep -rnE "$sql_owned_tables" --include='*.ts' "$TARGET_DIR" || true)"

if [ -n "$sql_violations" ]; then
  echo "arch-lint: advisor/conversation SQL must live in its owning repository (src/repositories/advisorRepository.ts, src/repositories/conversationRepository.ts) or be explicitly marked with arch-lint-allow-legacy-sql" >&2
  echo "$sql_violations" >&2
  exit 1
fi

echo "arch-lint: ok ($TARGET_DIR)"
