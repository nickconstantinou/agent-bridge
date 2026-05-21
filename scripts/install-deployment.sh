#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_DIR="/etc/systemd/system"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
TARGET_USER="${SUDO_USER:-$(whoami)}"
TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"

if [[ -z "${NODE_BIN}" ]]; then
  echo "node not found on PATH" >&2
  exit 1
fi

install_unit() {
  local name="$1"
  sed -e "s/BRIDGE_USER/${TARGET_USER}/g" \
      "${REPO_DIR}/systemd/${name}.service" \
    | sudo tee "${SYSTEMD_DIR}/${name}.service" > /dev/null
  sudo chmod 0644 "${SYSTEMD_DIR}/${name}.service"
}

install_shared_skills() {
  local skills_csv="${AGENT_BRIDGE_SKILLS:-}"
  local link_mode="${AGENT_BRIDGE_SKILL_LINK_MODE:-symlink}"
  if [[ -z "${skills_csv}" ]]; then
    return
  fi
  if [[ -z "${TARGET_HOME}" ]]; then
    echo "Unable to resolve target home for ${TARGET_USER}" >&2
    exit 1
  fi
  if [[ "${link_mode}" != "symlink" && "${link_mode}" != "copy" ]]; then
    echo "Invalid AGENT_BRIDGE_SKILL_LINK_MODE: ${link_mode}" >&2
    exit 1
  fi

  IFS=',' read -r -a skills <<< "${skills_csv}"
  for skill in "${skills[@]}"; do
    skill="$(echo "${skill}" | xargs)"
    [[ -n "${skill}" ]] || continue
    echo "Installing shared skill: ${skill} (${link_mode})"
    if [[ "${USER}" == "${TARGET_USER}" ]]; then
      (cd "${REPO_DIR}" && SHARED_MEMORY_HOME="${TARGET_HOME}" ./node_modules/.bin/tsx scripts/skill-manager.ts install "${skill}" --force --link-mode "${link_mode}")
    else
      sudo -u "${TARGET_USER}" env HOME="${TARGET_HOME}" SHARED_MEMORY_HOME="${TARGET_HOME}" \
        bash -c 'cd "$1" && ./node_modules/.bin/tsx scripts/skill-manager.ts install "$2" --force --link-mode "$3"' bash "${REPO_DIR}" "${skill}" "${link_mode}"
    fi
  done
}

if [[ "${1:-}" != "--skip-cli-install" ]]; then
  if command -v npm >/dev/null 2>&1; then
    (cd "${REPO_DIR}" && npm install)
    npm update -g @anthropic-ai/claude-code 2>/dev/null || true
    install_shared_skills
  fi

  if command -v codex >/dev/null 2>&1; then
    codex --help >/dev/null
  fi

  if ! command -v agy >/dev/null 2>&1; then
    echo "Installing agy..."
    curl -fsSL https://antigravity.google/cli/install.sh | bash
  fi
  if command -v agy >/dev/null 2>&1; then
    agy --help >/dev/null
  fi

  if command -v claude >/dev/null 2>&1; then
    claude --version >/dev/null
  fi
elif [[ -n "${AGENT_BRIDGE_SKILLS:-}" ]]; then
  install_shared_skills
fi

install_unit agent-bridge-codex
install_unit agent-bridge-antigravity

UNITS_TO_ENABLE="agent-bridge-codex agent-bridge-antigravity"

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
if [[ -n "${AGENT_BRIDGE_SKILLS:-}" ]]; then
  echo "Shared skills installed for ${TARGET_USER}: ${AGENT_BRIDGE_SKILLS}"
fi
