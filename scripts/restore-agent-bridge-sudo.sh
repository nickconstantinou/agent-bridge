#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run this script as root: sudo bash scripts/restore-agent-bridge-sudo.sh" >&2
  exit 1
fi

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

install -D -m 0750 -o root -g root "${repo_dir}/scripts/restart-agent-bridge.sh" /usr/local/sbin/restart-agent-bridge
install -D -m 0750 -o root -g root "${repo_dir}/scripts/rollout-agent-bridge.sh" /usr/local/sbin/rollout-agent-bridge
install -D -m 0750 -o root -g root "${repo_dir}/scripts/rollout-restore.py" /usr/local/libexec/agent-bridge-rollout-restore

cat > /etc/sudoers.d/agent-bridge-restart <<'EOF'
content-crawler ALL=(root) NOPASSWD: /usr/local/sbin/restart-agent-bridge
EOF

cat > /etc/sudoers.d/agent-bridge-rollout <<'EOF'
content-crawler ALL=(root) NOPASSWD: /usr/local/sbin/rollout-agent-bridge
EOF

chmod 0440 /etc/sudoers.d/agent-bridge-restart /etc/sudoers.d/agent-bridge-rollout
visudo -cf /etc/sudoers.d/agent-bridge-restart
visudo -cf /etc/sudoers.d/agent-bridge-rollout

echo "Restored narrow sudo control for agent-bridge restart and rollout helpers."
