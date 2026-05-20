#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_DIR="/etc/systemd/system"
DEFAULTS_DIR="/etc/default"
NODE_MIN_MAJOR=22
TARGET_USER="${SUDO_USER:-${USER}}"
TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"

cat <<'EOF'
agent-bridge install
- codex service reads: .env.codex
- antigravity service reads: .env.antigravity
- claude service reads: .env.claude  (optional — skipped if no token provided)
- BRIDGE_ENV_FILE must point at the bot-specific env file
- CODEX_PROJECT_DIR / ANTIGRAVITY_PROJECT_DIR / CLAUDE_PROJECT_DIR override the CLI cwd per bot
- shared local memory is configured automatically for codex, antigravity, and claude
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

ensure_target_user() {
  if [[ -z "${TARGET_USER}" || -z "${TARGET_HOME}" ]]; then
    echo "Unable to resolve the target user and home directory." >&2
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
  for key in BRIDGE_ROOT_DIR BRIDGE_PROJECT_DIR TELEGRAM_ALLOWED_USER_ID TELEGRAM_BOT_TOKEN_CODEX TELEGRAM_BOT_TOKEN_ANTIGRAVITY TELEGRAM_BOT_TOKEN_CLAUDE CODEX_COMMAND ANTIGRAVITY_COMMAND CLAUDE_COMMAND BRIDGE_EXECUTION_MODE; do
    value="$(env_file_get "${file}" "${key}")"
    if [[ -n "${value}" && -z "${!key:-}" ]]; then
      export "${key}=${value}"
    fi
  done
}

seed_from_env_file "${REPO_DIR}/.env.codex"
seed_from_env_file "${REPO_DIR}/.env.antigravity"
seed_from_env_file "${REPO_DIR}/.env.claude"

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

prompt BRIDGE_ROOT_DIR "Bridge root directory" "${TARGET_HOME}"
prompt BRIDGE_PROJECT_DIR "Bridge project directory" "${REPO_DIR}"
prompt TELEGRAM_ALLOWED_USER_ID "Telegram allowed user id"
prompt TELEGRAM_BOT_TOKEN_CODEX "Codex bot token"
prompt TELEGRAM_BOT_TOKEN_ANTIGRAVITY "Antigravity bot token"
prompt TELEGRAM_BOT_TOKEN_CLAUDE "Claude bot token (leave blank to skip)"
prompt CODEX_COMMAND "Codex command" "$(command -v codex || true)"
prompt ANTIGRAVITY_COMMAND "Antigravity command" "$(command -v agy || true)"
prompt CLAUDE_COMMAND "Claude command" "$(command -v claude || true)"
prompt BRIDGE_EXECUTION_MODE "Execution mode (safe|trusted)" "trusted"

ensure_var BRIDGE_ROOT_DIR "Bridge root directory"
ensure_var BRIDGE_PROJECT_DIR "Bridge project directory"
ensure_var TELEGRAM_ALLOWED_USER_ID "Telegram allowed user id"
ensure_var TELEGRAM_BOT_TOKEN_CODEX "Codex bot token"
ensure_var TELEGRAM_BOT_TOKEN_ANTIGRAVITY "Antigravity bot token"
ensure_var BRIDGE_EXECUTION_MODE "Execution mode"

mkdir -p "${DEFAULTS_DIR}"

cat > "${DEFAULTS_DIR}/agent-bridge-codex" <<EOF
BRIDGE_ROOT_DIR=${BRIDGE_ROOT_DIR}
BRIDGE_PROJECT_DIR=${BRIDGE_PROJECT_DIR}
BRIDGE_ENV_FILE=/etc/default/agent-bridge-codex
TELEGRAM_BOT_TOKEN_CODEX=${TELEGRAM_BOT_TOKEN_CODEX}
TELEGRAM_ALLOWED_USER_ID=${TELEGRAM_ALLOWED_USER_ID}
CODEX_COMMAND=${CODEX_COMMAND}
BRIDGE_EXECUTION_MODE=${BRIDGE_EXECUTION_MODE}
EOF

cat > "${DEFAULTS_DIR}/agent-bridge-antigravity" <<EOF
BRIDGE_ROOT_DIR=${BRIDGE_ROOT_DIR}
BRIDGE_PROJECT_DIR=${BRIDGE_PROJECT_DIR}
BRIDGE_ENV_FILE=/etc/default/agent-bridge-antigravity
TELEGRAM_BOT_TOKEN_ANTIGRAVITY=${TELEGRAM_BOT_TOKEN_ANTIGRAVITY}
TELEGRAM_ALLOWED_USER_ID=${TELEGRAM_ALLOWED_USER_ID}
ANTIGRAVITY_COMMAND=${ANTIGRAVITY_COMMAND}
BRIDGE_EXECUTION_MODE=${BRIDGE_EXECUTION_MODE}
EOF

if [[ -n "${TELEGRAM_BOT_TOKEN_CLAUDE:-}" ]]; then
  cat > "${DEFAULTS_DIR}/agent-bridge-claude" <<EOF
BRIDGE_ROOT_DIR=${BRIDGE_ROOT_DIR}
BRIDGE_PROJECT_DIR=${BRIDGE_PROJECT_DIR}
BRIDGE_ENV_FILE=/etc/default/agent-bridge-claude
TELEGRAM_BOT_TOKEN_CLAUDE=${TELEGRAM_BOT_TOKEN_CLAUDE}
TELEGRAM_ALLOWED_USER_ID=${TELEGRAM_ALLOWED_USER_ID}
CLAUDE_COMMAND=${CLAUDE_COMMAND}
BRIDGE_EXECUTION_MODE=${BRIDGE_EXECUTION_MODE}
EOF
fi

install_unit() {
  local name="$1"
  sed -e "s/BRIDGE_USER/${TARGET_USER}/g" \
      "${REPO_DIR}/systemd/${name}.service" \
    | sudo tee "${SYSTEMD_DIR}/${name}.service" > /dev/null
  sudo chmod 0644 "${SYSTEMD_DIR}/${name}.service"
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
ensure_target_user

if [[ "${1:-}" != "--skip-cli-install" ]]; then
  if command -v npm >/dev/null 2>&1; then
    (cd "${REPO_DIR}" && npm install)
    ensure_cli codex @openai/codex
    ensure_cli agy @google/antigravity-cli
    ensure_cli claude @anthropic-ai/claude-code
    CODEX_COMMAND="${CODEX_COMMAND:-$(command -v codex || true)}"
    ANTIGRAVITY_COMMAND="${ANTIGRAVITY_COMMAND:-$(command -v agy || true)}"
    CLAUDE_COMMAND="${CLAUDE_COMMAND:-$(command -v claude || true)}"
    if [[ "${USER}" == "${TARGET_USER}" ]]; then
      (cd "${REPO_DIR}" && SHARED_MEMORY_HOME="${TARGET_HOME}" ./node_modules/.bin/tsx scripts/setup-shared-memory.ts)
    else
      sudo -u "${TARGET_USER}" env HOME="${TARGET_HOME}" SHARED_MEMORY_HOME="${TARGET_HOME}" \
        bash -lc "cd \"${REPO_DIR}\" && ./node_modules/.bin/tsx scripts/setup-shared-memory.ts"
    fi
  fi
fi

ensure_var CODEX_COMMAND "Codex command"
ensure_var ANTIGRAVITY_COMMAND "Antigravity command"
if [[ -n "${TELEGRAM_BOT_TOKEN_CLAUDE:-}" ]]; then
  ensure_var CLAUDE_COMMAND "Claude command"
fi

install_unit agent-bridge-codex
install_unit agent-bridge-antigravity

UNITS_TO_ENABLE="agent-bridge-codex agent-bridge-antigravity"

if [[ -n "${TELEGRAM_BOT_TOKEN_CLAUDE:-}" ]]; then
  install_unit agent-bridge-claude
  UNITS_TO_ENABLE="${UNITS_TO_ENABLE} agent-bridge-claude"
fi

sudo systemctl daemon-reload
# shellcheck disable=SC2086
sudo systemctl enable --now ${UNITS_TO_ENABLE}

echo "Installed and started: ${UNITS_TO_ENABLE}"
echo "Defaults written to ${DEFAULTS_DIR}/"
echo "Shared local memory configured for codex, antigravity, and claude"
