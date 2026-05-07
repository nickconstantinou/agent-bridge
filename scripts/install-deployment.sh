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
  sudo install -m 0644 "${REPO_DIR}/systemd/${name}.service" "${SYSTEMD_DIR}/${name}.service"
}

if [[ "${1:-}" != "--skip-cli-install" ]]; then
  if command -v npm >/dev/null 2>&1; then
    (cd "${REPO_DIR}" && npm install)
  fi

  if command -v codex >/dev/null 2>&1; then
    codex --help >/dev/null
  fi

  if command -v gemini >/dev/null 2>&1; then
    gemini --help >/dev/null
  fi
fi

install_unit agent-bridge-codex
install_unit agent-bridge-gemini

sudo systemctl daemon-reload
sudo systemctl enable --now agent-bridge-codex agent-bridge-gemini

echo "Installed and started agent-bridge-codex and agent-bridge-gemini"
echo "Node: ${NODE_BIN}"
