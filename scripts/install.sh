#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_DIR="/etc/systemd/system"
DEFAULTS_DIR="/etc/default"
NODE_MIN_MAJOR=22
TARGET_USER="${SUDO_USER:-${USER}}"
TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"
DEFAULT_AGENT_BRIDGE_SKILLS="red-green-refactor-tdd,requirements-to-acceptance,risk-based-test-strategy,release-readiness-review"

# Parse flags
NON_INTERACTIVE=0
SKIP_CLI_INSTALL=0
for _arg in "$@"; do
  case "${_arg}" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    --skip-cli-install) SKIP_CLI_INSTALL=1 ;;
  esac
done

cat <<'EOF'
agent-bridge install
- codex service reads: .env.codex
- antigravity service reads: .env.antigravity
- claude service reads: .env.claude  (optional — skipped if no token provided)
- BRIDGE_ENV_FILE must point at the bot-specific env file
- CODEX_PROJECT_DIR / ANTIGRAVITY_PROJECT_DIR / CLAUDE_PROJECT_DIR override the CLI cwd per bot
- shared local memory is configured automatically for codex, antigravity, and claude
- bundled shared skills are installed into native CLI skill directories by default
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
  for key in BRIDGE_ROOT_DIR BRIDGE_PROJECT_DIR \
              TELEGRAM_ALLOWED_USER_IDS TELEGRAM_ALLOWED_USER_ID \
              TELEGRAM_BOT_TOKEN_CODEX TELEGRAM_BOT_TOKEN_ANTIGRAVITY TELEGRAM_BOT_TOKEN_CLAUDE \
              CODEX_COMMAND ANTIGRAVITY_COMMAND CLAUDE_COMMAND \
              CODEX_PROJECT_DIR ANTIGRAVITY_PROJECT_DIR CLAUDE_PROJECT_DIR \
              AGENT_BRIDGE_SKILLS AGENT_BRIDGE_SKILL_LINK_MODE \
              BRIDGE_EXECUTION_MODE POLL_INTERVAL_MS AGENT_MEMORY_DB_PATH \
              AGENT_BRIDGE_SOUL_PATH AGENT_BRIDGE_SOUL_MODE; do
    value="$(env_file_get "${file}" "${key}")"
    if [[ -n "${value}" && -z "${!key:-}" ]]; then
      export "${key}=${value}"
    fi
  done
  # Normalise singular alias → plural
  if [[ -z "${TELEGRAM_ALLOWED_USER_IDS:-}" && -n "${TELEGRAM_ALLOWED_USER_ID:-}" ]]; then
    export TELEGRAM_ALLOWED_USER_IDS="${TELEGRAM_ALLOWED_USER_ID}"
  fi
}

# write_env_file <example> <target>
# Reads the example line-by-line. For each KEY= line, substitutes the current
# shell value if set; otherwise keeps the example's default verbatim.
write_env_file() {
  local example="$1"
  local target="$2"
  local tmpfile
  tmpfile="$(mktemp)"
  while IFS= read -r line || [[ -n "${line}" ]]; do
    if [[ "${line}" =~ ^([A-Z_][A-Z0-9_]*)= ]]; then
      local key="${BASH_REMATCH[1]}"
      local envval="${!key:-}"
      if [[ -n "${envval}" ]]; then
        printf '%s=%s\n' "${key}" "${envval}"
      else
        printf '%s\n' "${line}"
      fi
    else
      printf '%s\n' "${line}"
    fi
  done < "${example}" > "${tmpfile}"
  mv "${tmpfile}" "${target}"
  echo "  wrote ${target}"
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
  if [[ "${NON_INTERACTIVE}" == "1" ]]; then
    # Use default silently, or leave empty (required vars will be caught by ensure_var)
    export "${var}=${default}"
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
    echo "Error: Missing required value for ${label}." >&2
    if [[ "${NON_INTERACTIVE}" == "1" ]]; then
      echo "  Set it via the environment before calling install.sh --non-interactive." >&2
    fi
    exit 1
  fi
}

prompt BRIDGE_ROOT_DIR    "Bridge root directory"    "${TARGET_HOME}"
prompt BRIDGE_PROJECT_DIR "Bridge project directory" "${REPO_DIR}"
prompt TELEGRAM_ALLOWED_USER_IDS  "Telegram allowed user IDs (comma-separated)"
prompt TELEGRAM_BOT_TOKEN_CODEX       "Codex bot token"
prompt TELEGRAM_BOT_TOKEN_ANTIGRAVITY "Antigravity bot token"
prompt TELEGRAM_BOT_TOKEN_CLAUDE      "Claude bot token (leave blank to skip)"
prompt CODEX_COMMAND       "Codex command"       "$(command -v codex  2>/dev/null || true)"
prompt ANTIGRAVITY_COMMAND "Antigravity command" "$(command -v agy    2>/dev/null || true)"
prompt CLAUDE_COMMAND      "Claude command"      "$(command -v claude 2>/dev/null || true)"
prompt CODEX_PROJECT_DIR       "Codex working directory (blank = BRIDGE_PROJECT_DIR)"       ""
prompt ANTIGRAVITY_PROJECT_DIR "Antigravity working directory (blank = BRIDGE_PROJECT_DIR)" ""
prompt CLAUDE_PROJECT_DIR      "Claude working directory (blank = BRIDGE_PROJECT_DIR)"      ""
prompt AGENT_BRIDGE_SKILLS "Bundled skills to install (comma-separated, none = skip)" "${DEFAULT_AGENT_BRIDGE_SKILLS}"
prompt AGENT_BRIDGE_SKILL_LINK_MODE "Shared skill link mode (symlink|copy)" "symlink"
prompt BRIDGE_EXECUTION_MODE "Execution mode (safe|trusted)" "trusted"
prompt POLL_INTERVAL_MS      "Poll interval ms"               "1000"
prompt AGENT_MEMORY_DB_PATH  "Agent memory DB path (blank = default)" ""

ensure_var BRIDGE_ROOT_DIR           "Bridge root directory"
ensure_var BRIDGE_PROJECT_DIR        "Bridge project directory"
ensure_var TELEGRAM_ALLOWED_USER_IDS "Telegram allowed user IDs"
ensure_var TELEGRAM_BOT_TOKEN_CODEX        "Codex bot token"
ensure_var TELEGRAM_BOT_TOKEN_ANTIGRAVITY  "Antigravity bot token"
ensure_var BRIDGE_EXECUTION_MODE     "Execution mode"

install_shared_skills() {
  local skills_csv="${AGENT_BRIDGE_SKILLS:-${DEFAULT_AGENT_BRIDGE_SKILLS}}"
  local link_mode="${AGENT_BRIDGE_SKILL_LINK_MODE:-symlink}"
  if [[ -z "${skills_csv}" || "${skills_csv}" == "none" || "${skills_csv}" == "skip" ]]; then
    return
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

mkdir -p "${DEFAULTS_DIR}"

install_unit() {
  local name="$1"
  sed -e "s/BRIDGE_USER/${TARGET_USER}/g" \
      "${REPO_DIR}/systemd/${name}.service" \
    | sudo tee "${SYSTEMD_DIR}/${name}.service" > /dev/null
  sudo chmod 0644 "${SYSTEMD_DIR}/${name}.service"
}

# Returns the path to a binary: prefers global PATH, then local node_modules/.bin
resolve_binary() {
  local binary="$1"
  if command -v "${binary}" >/dev/null 2>&1; then
    command -v "${binary}"
    return
  fi
  local local_bin="${REPO_DIR}/node_modules/.bin/${binary}"
  if [[ -x "${local_bin}" ]]; then
    echo "${local_bin}"
    return
  fi
  echo ""
}

ensure_agy_cli() {
  if command -v agy >/dev/null 2>&1; then
    return
  fi
  echo "Installing agy via Google Antigravity installer"
  curl -fsSL https://antigravity.google/cli/install.sh | bash
  export PATH="${TARGET_HOME}/.local/bin:${PATH}"
}

require_node
ensure_target_user

if [[ "${SKIP_CLI_INSTALL}" != "1" ]]; then
  if command -v npm >/dev/null 2>&1; then
    # npm install pulls codex and claude-code into ./node_modules as local deps
    (cd "${REPO_DIR}" && npm install)
    ensure_agy_cli
    # Resolve CLI binary paths: global path first, then local node_modules/.bin
    CODEX_COMMAND="${CODEX_COMMAND:-$(resolve_binary codex)}"
    ANTIGRAVITY_COMMAND="${ANTIGRAVITY_COMMAND:-$(resolve_binary agy)}"
    CLAUDE_COMMAND="${CLAUDE_COMMAND:-$(resolve_binary claude)}"
    if [[ "${USER}" == "${TARGET_USER}" ]]; then
      (cd "${REPO_DIR}" && SHARED_MEMORY_HOME="${TARGET_HOME}" ./node_modules/.bin/tsx scripts/setup-shared-memory.ts)
    else
      sudo -u "${TARGET_USER}" env HOME="${TARGET_HOME}" SHARED_MEMORY_HOME="${TARGET_HOME}" \
        bash -lc "cd \"${REPO_DIR}\" && ./node_modules/.bin/tsx scripts/setup-shared-memory.ts"
    fi
    install_shared_skills
  fi
elif [[ -n "${AGENT_BRIDGE_SKILLS:-}" ]]; then
  install_shared_skills
fi

ensure_var CODEX_COMMAND       "Codex command"
ensure_var ANTIGRAVITY_COMMAND "Antigravity command"
if [[ -n "${TELEGRAM_BOT_TOKEN_CLAUDE:-}" ]]; then
  ensure_var CLAUDE_COMMAND "Claude command"
fi

# Write local .env.* files from examples (machine-specific values substituted in)
echo "Writing local env files..."
write_env_file "${REPO_DIR}/.env.codex.example"      "${REPO_DIR}/.env.codex"
write_env_file "${REPO_DIR}/.env.antigravity.example" "${REPO_DIR}/.env.antigravity"
if [[ -n "${TELEGRAM_BOT_TOKEN_CLAUDE:-}" ]]; then
  write_env_file "${REPO_DIR}/.env.claude.example"   "${REPO_DIR}/.env.claude"
fi

# Write systemd defaults (include all vars so services are self-contained)
_write_systemd_defaults() {
  local bot="$1"
  local token_var="$2"
  local cmd_var="$3"
  local proj_var="$4"
  local dest="${DEFAULTS_DIR}/agent-bridge-${bot}"

  {
    echo "BRIDGE_ROOT_DIR=${BRIDGE_ROOT_DIR}"
    echo "BRIDGE_PROJECT_DIR=${BRIDGE_PROJECT_DIR}"
    echo "BRIDGE_ENV_FILE=${dest}"
    echo "${token_var}=${!token_var:-}"
    echo "TELEGRAM_ALLOWED_USER_IDS=${TELEGRAM_ALLOWED_USER_IDS}"
    echo "${cmd_var}=${!cmd_var:-}"
    [[ -n "${!proj_var:-}" ]] && echo "${proj_var}=${!proj_var}"
    echo "BRIDGE_EXECUTION_MODE=${BRIDGE_EXECUTION_MODE}"
    echo "BRIDGE_ASYNC_ENABLED=true"
    echo "POLL_INTERVAL_MS=${POLL_INTERVAL_MS:-1000}"
    [[ -n "${AGENT_MEMORY_DB_PATH:-}" ]] && echo "AGENT_MEMORY_DB_PATH=${AGENT_MEMORY_DB_PATH}"
    [[ -n "${AGENT_BRIDGE_SOUL_PATH:-}" ]] && echo "AGENT_BRIDGE_SOUL_PATH=${AGENT_BRIDGE_SOUL_PATH}"
    [[ -n "${AGENT_BRIDGE_SOUL_MODE:-}" ]] && echo "AGENT_BRIDGE_SOUL_MODE=${AGENT_BRIDGE_SOUL_MODE}"
  } | sudo tee "${dest}" > /dev/null
}

_write_systemd_defaults codex       TELEGRAM_BOT_TOKEN_CODEX       CODEX_COMMAND       CODEX_PROJECT_DIR
_write_systemd_defaults antigravity TELEGRAM_BOT_TOKEN_ANTIGRAVITY ANTIGRAVITY_COMMAND ANTIGRAVITY_PROJECT_DIR

install_unit agent-bridge-codex
install_unit agent-bridge-antigravity

UNITS_TO_ENABLE="agent-bridge-codex agent-bridge-antigravity"

if [[ -n "${TELEGRAM_BOT_TOKEN_CLAUDE:-}" ]]; then
  _write_systemd_defaults claude TELEGRAM_BOT_TOKEN_CLAUDE CLAUDE_COMMAND CLAUDE_PROJECT_DIR
  install_unit agent-bridge-claude
  UNITS_TO_ENABLE="${UNITS_TO_ENABLE} agent-bridge-claude"
fi

sudo systemctl daemon-reload
# shellcheck disable=SC2086
sudo systemctl enable --now ${UNITS_TO_ENABLE}

echo "Installed and started: ${UNITS_TO_ENABLE}"
echo "Defaults written to ${DEFAULTS_DIR}/"
echo "Shared local memory configured for codex, antigravity, and claude"
if [[ -n "${AGENT_BRIDGE_SKILLS:-}" && "${AGENT_BRIDGE_SKILLS}" != "none" && "${AGENT_BRIDGE_SKILLS}" != "skip" ]]; then
  echo "Shared skills installed: ${AGENT_BRIDGE_SKILLS}"
fi
