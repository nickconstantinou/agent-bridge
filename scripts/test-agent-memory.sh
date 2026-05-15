#!/usr/bin/env bash
set -euo pipefail

TMP_DB="$(mktemp -u /tmp/agent-memory-test.XXXXXX.sqlite)"
export AGENT_MEMORY_DB_PATH="$TMP_DB"

npm run agent-memory -- add --type decision --scope project --text "Test memory" >/dev/null
npm run agent-memory -- recall --query "Test memory" --scope project --limit 5 --json
