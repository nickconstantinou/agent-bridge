#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_DIR="/etc/systemd/system"
DEFAULTS_DIR="/etc/default"
NODE_MIN_MAJOR=22

cat <<'EOF'
agent-bridge install
- codex service reads: .env.codex
- gemini service reads: .env.gemini
- BRIDGE_ENV_FILE must point at the bot-specific env file
- CODEX_PROJECT_DIR / GEMINI_PROJECT_DIR override the CLI cwd per bot
- shared MCP memory is configured automatically for codex, gemini, and claude
EOF

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js ${NODE_MIN_MAJOR}+ is required." >&2
    exit 1
  fi

  local version major
  version="$(node -p 'process.versions.node')"
  major="${version%%.*}"
  if (( major < NODE_MIN_MAJOR )); then
    echo "Node.js ${NODE_MIN_MAJOR}+ is required. Found ${version}." >&2
    exit 1
  fi
}

env_file_get() {
  local file="$1" key="$2"
  [[ -f "${file}" ]] || return 0
  awk -F= -v key="${key}" '
    $0 !~ /^[[:space:]]*#/ && $1 == key {
      sub(/^[^=]*=/, "");
      print;
      exit
    }
  ' "${file}"
}

seed_from_env_file() {
  local file="$1"
  local key value
  for key in BRIDGE_ROOT_DIR BRIDGE_PROJECT_DIR TELEGRAM_ALLOWED_USER_ID TELEGRAM_BOT_TOKEN_CODEX TELEGRAM_BOT_TOKEN_GEMINI CODEX_COMMAND GEMINI_COMMAND CLAUDE_COMMAND BRIDGE_EXECUTION_MODE; do
    value="$(env_file_get "${file}" "${key}")"
    if [[ -n "${value}" && -z "${!key:-}" ]]; then
      export "${key}=${value}"
    fi
  done
}

seed_from_env_file "${REPO_DIR}/.env.codex"
seed_from_env_file "${REPO_DIR}/.env.gemini"

prompt() {
  local var="$1" label="$2" default="${3:-}"
  local current="${!var:-}"
  if [[ -n "${current}" ]]; then
    return
  fi
  if [[ -n "${default}" ]]; then
    read -r -p "${label} [${default}]: " current || true
    current="${current:-$default}"
  else
    read -r -p "${label}: " current || true
  fi
  export "${var}=${current}"
}

ensure_var() {
  local var="$1" label="$2"
  if [[ -z "${!var:-}" ]]; then
    echo "Missing required value: ${label}" >&2
    exit 1
  fi
}

prompt BRIDGE_ROOT_DIR "Bridge root directory" "${HOME}"
prompt BRIDGE_PROJECT_DIR "Bridge project directory" "${REPO_DIR}"
prompt TELEGRAM_ALLOWED_USER_ID "Telegram allowed user id"
prompt TELEGRAM_BOT_TOKEN_CODEX "Codex bot token"
prompt TELEGRAM_BOT_TOKEN_GEMINI "Gemini bot token"
prompt CODEX_COMMAND "Codex command" "$(command -v codex || true)"
prompt GEMINI_COMMAND "Gemini command" "$(command -v gemini || true)"
prompt CLAUDE_COMMAND "Claude command" "$(command -v claude || true)"
prompt BRIDGE_EXECUTION_MODE "Execution mode (safe|trusted)" "trusted"

ensure_var BRIDGE_ROOT_DIR "Bridge root directory"
ensure_var BRIDGE_PROJECT_DIR "Bridge project directory"
ensure_var TELEGRAM_ALLOWED_USER_ID "Telegram allowed user id"
ensure_var TELEGRAM_BOT_TOKEN_CODEX "Codex bot token"
ensure_var TELEGRAM_BOT_TOKEN_GEMINI "Gemini bot token"
ensure_var BRIDGE_EXECUTION_MODE "Execution mode"

mkdir -p "${DEFAULTS_DIR}"

cat > "${DEFAULTS_DIR}/agent-bridge-codex" <<EOF
BRIDGE_ROOT_DIR=${BRIDGE_ROOT_DIR}
BRIDGE_PROJECT_DIR=${BRIDGE_PROJECT_DIR}
BRIDGE_ENV_FILE=${BRIDGE_PROJECT_DIR}/.env.codex
TELEGRAM_BOT_TOKEN_CODEX=${TELEGRAM_BOT_TOKEN_CODEX}
TELEGRAM_ALLOWED_USER_ID=${TELEGRAM_ALLOWED_USER_ID}
CODEX_COMMAND=${CODEX_COMMAND}
BRIDGE_EXECUTION_MODE=${BRIDGE_EXECUTION_MODE}
EOF

cat > "${DEFAULTS_DIR}/agent-bridge-gemini" <<EOF
BRIDGE_ROOT_DIR=${BRIDGE_ROOT_DIR}
BRIDGE_PROJECT_DIR=${BRIDGE_PROJECT_DIR}
BRIDGE_ENV_FILE=${BRIDGE_PROJECT_DIR}/.env.gemini
TELEGRAM_BOT_TOKEN_GEMINI=${TELEGRAM_BOT_TOKEN_GEMINI}
TELEGRAM_ALLOWED_USER_ID=${TELEGRAM_ALLOWED_USER_ID}
GEMINI_COMMAND=${GEMINI_COMMAND}
BRIDGE_EXECUTION_MODE=${BRIDGE_EXECUTION_MODE}
EOF

install_unit() {
  local name="$1"
  sudo install -m 0644 "${REPO_DIR}/systemd/${name}.service" "${SYSTEMD_DIR}/${name}.service"
}

ensure_cli() {
  local binary="$1" package="$2"
  if command -v "${binary}" >/dev/null 2>&1; then
    return
  fi
  echo "Installing ${binary} via npm (${package})"
  npm install -g "${package}"
}

require_node

if [[ "${1:-}" != "--skip-cli-install" ]]; then
  if command -v npm >/dev/null 2>&1; then
    (cd "${REPO_DIR}" && npm install)
    ensure_cli codex @openai/codex
    ensure_cli gemini @google/gemini-cli
    ensure_cli claude @anthropic-ai/claude-code
    CODEX_COMMAND="${CODEX_COMMAND:-$(command -v codex || true)}"
    GEMINI_COMMAND="${GEMINI_COMMAND:-$(command -v gemini || true)}"
    CLAUDE_COMMAND="${CLAUDE_COMMAND:-$(command -v claude || true)}"
    (cd "${REPO_DIR}" && ./node_modules/.bin/tsx scripts/setup-shared-memory.ts)
  fi
fi

ensure_var CODEX_COMMAND "Codex command"
ensure_var GEMINI_COMMAND "Gemini command"
ensure_var CLAUDE_COMMAND "Claude command"

install_unit agent-bridge-codex
install_unit agent-bridge-gemini

sudo systemctl daemon-reload
sudo systemctl enable --now agent-bridge-codex agent-bridge-gemini

echo "Installed and started agent-bridge-codex and agent-bridge-gemini"
echo "Defaults written to ${DEFAULTS_DIR}/agent-bridge-codex and ${DEFAULTS_DIR}/agent-bridge-gemini"
echo "Shared MCP memory configured for codex, gemini, and claude"
