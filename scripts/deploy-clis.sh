#!/usr/bin/env bash
# Update all agent-bridge CLI dependencies and restart bridge services.
# Safe to run while services are live — restarts one service at a time.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
SERVICES=(
  agent-bridge-claude
  agent-bridge-codex
  agent-bridge-antigravity
  agent-bridge-interactive
  agent-bridge-discord
  agent-bridge-discord-interactive
)

log() { echo "[deploy-clis] $*"; }
ok()  { echo "[deploy-clis] ✓ $*"; }
err() { echo "[deploy-clis] ✗ $*" >&2; }

cd "${REPO_DIR}"

# ── 1. Update CLI npm packages ─────────────────────────────────────────────────
log "Updating CLI packages..."
npm install \
  "@anthropic-ai/claude-code@latest" \
  "@openai/codex@latest"
ok "npm packages updated"

# ── 2. Update agy if installed globally ────────────────────────────────────────
if command -v agy >/dev/null 2>&1; then
  log "Updating agy (antigravity)..."
  agy update 2>/dev/null || log "agy update not supported — skipping (reinstall manually if needed)"
fi

# ── 3. Build TypeScript ────────────────────────────────────────────────────────
log "Building bridge..."
npm run build
ok "Build passed"

# ── 4. Run test suite ──────────────────────────────────────────────────────────
log "Running tests..."
if npm test 2>&1 | tail -5; then
  ok "Tests passed"
else
  err "Tests FAILED — aborting service restarts"
  exit 1
fi

# ── 5. Restart active services one at a time ──────────────────────────────────
log "Restarting active services..."
for svc in "${SERVICES[@]}"; do
  if systemctl is-active --quiet "${svc}" 2>/dev/null; then
    log "  Restarting ${svc}..."
    sudo systemctl restart "${svc}"
    sleep 2
    if systemctl is-active --quiet "${svc}"; then
      ok "  ${svc} running"
    else
      err "  ${svc} failed to start — check: sudo journalctl -u ${svc} -n 50"
    fi
  else
    log "  Skipping ${svc} (not active)"
  fi
done

ok "Deploy complete"
