#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_DIR="/etc/systemd/system"
DEFAULTS_DIR="/etc/default"

cat <<'EOF'
agent-bridge install
- codex service reads: .env.codex
- gemini service reads: .env.gemini
- BRIDGE_ENV_FILE must point at the bot-specific env file
- CODEX_PROJECT_DIR / GEMINI_PROJECT_DIR override the CLI cwd per bot
EOF

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
prompt BRIDGE_EXECUTION_MODE "Execution mode (safe|trusted)" "trusted"

ensure_var BRIDGE_ROOT_DIR "Bridge root directory"
ensure_var BRIDGE_PROJECT_DIR "Bridge project directory"
ensure_var TELEGRAM_ALLOWED_USER_ID "Telegram allowed user id"
ensure_var TELEGRAM_BOT_TOKEN_CODEX "Codex bot token"
ensure_var TELEGRAM_BOT_TOKEN_GEMINI "Gemini bot token"
ensure_var CODEX_COMMAND "Codex command"
ensure_var GEMINI_COMMAND "Gemini command"
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

if [[ "${1:-}" != "--skip-cli-install" ]]; then
  if command -v npm >/dev/null 2>&1; then
    (cd "${REPO_DIR}" && npm install)
  fi
fi

install_unit agent-bridge-codex
install_unit agent-bridge-gemini

sudo systemctl daemon-reload
sudo systemctl enable --now agent-bridge-codex agent-bridge-gemini

echo "Installed and started agent-bridge-codex and agent-bridge-gemini"
echo "Defaults written to ${DEFAULTS_DIR}/agent-bridge-codex and ${DEFAULTS_DIR}/agent-bridge-gemini"
