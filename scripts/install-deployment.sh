#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_DIR="/etc/systemd/system"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

if [[ -z "${NODE_BIN}" ]]; then
  echo "node not found on PATH" >&2
  exit 1
fi

install_unit() {
  local name="$1"
  sed -e "s/BRIDGE_USER/$(whoami)/g" \
      "${REPO_DIR}/systemd/${name}.service" \
    | sudo tee "${SYSTEMD_DIR}/${name}.service" > /dev/null
  sudo chmod 0644 "${SYSTEMD_DIR}/${name}.service"
}

if [[ "${1:-}" != "--skip-cli-install" ]]; then
  if command -v npm >/dev/null 2>&1; then
    (cd "${REPO_DIR}" && npm install)
    npm update -g @anthropic-ai/claude-code 2>/dev/null || true
  fi

  if command -v codex >/dev/null 2>&1; then
    codex --help >/dev/null
  fi

  if command -v gemini >/dev/null 2>&1; then
    gemini --help >/dev/null
  fi

  if command -v claude >/dev/null 2>&1; then
    claude --version >/dev/null
  fi
fi

install_unit agent-bridge-codex
install_unit agent-bridge-gemini

UNITS_TO_ENABLE="agent-bridge-codex agent-bridge-gemini"

# Install claude unit only if its defaults file is present (created by install.sh)
CLAUDE_DEFAULTS="/etc/default/agent-bridge-claude"
if [[ -f "${CLAUDE_DEFAULTS}" ]]; then
  install_unit agent-bridge-claude
  UNITS_TO_ENABLE="${UNITS_TO_ENABLE} agent-bridge-claude"
fi

sudo systemctl daemon-reload
# shellcheck disable=SC2086
sudo systemctl enable --now ${UNITS_TO_ENABLE}

echo "Installed and started: ${UNITS_TO_ENABLE}"
echo "Node: ${NODE_BIN}"
