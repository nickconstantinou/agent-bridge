# agent-bridge

Tiny single-user Telegram bridge for Codex CLI and Gemini CLI.

## Scope

- one shared repo, two separate service instances
- 2 Telegram bots: one for Codex, one for Gemini
- ignores unauthorized users silently
- text in, text out
- maintains one persisted session per bot
- simple commands: `/start`, `/models`, `/model <name>`, `/model reset`, `/reset`

## Production-Grade Enhancements

- **Media Group Aggregation**: Buffers photo/video albums into a single agent prompt.
- **Adaptive Rate Limiting**: Automatically handles Telegram's `429` (Too Many Requests) errors with smart backoff.
- **Forum/Topic Support**: Captures and preserves `message_thread_id` for correct conversation routing.
- **Robust Concurrency Locking**: Multi-node safety with automated stale lock recovery (via PID verification).
- **Smart MarkdownV2 Escaping**: AST-aware formatter that protects valid pairs and escapes orphaned markers.
- **Progressive Streaming**: Real-time feedback with throttled message edits (every 2 seconds).

## Setup

1. Install Node 22+
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy env file:
   ```bash
   cp .env.example .env
   ```
4. Fill in `.env`
5. Make sure these CLIs work on the server:
   ```bash
   codex --help
   gemini --help
   ```
6. Start:
   ```bash
   node src/index.js
   ```

## Run persistently with systemd

Recommended on a Linux server.

### Codex service

1. Create `/etc/systemd/system/agent-bridge-codex.service`:
   ```bash
   sudo tee /etc/systemd/system/agent-bridge-codex.service >/dev/null <<'EOF'
   [Unit]
   Description=Telegram bridge for Codex
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   User=<your-user>
   Environment=BRIDGE_ROOT_DIR=<your-home-dir>
   Environment=BRIDGE_PROJECT_DIR=<absolute-path-to-this-repo>
   Environment=BRIDGE_ENV_FILE=<absolute-path-to-service-env-file>
   Environment=CODEX_PROJECT_DIR=<absolute-path-to-codex-repo>
   Environment=TELEGRAM_BOT_TOKEN_CODEX=<codex-bot-token>
   Environment=TELEGRAM_ALLOWED_USER_ID=<your-telegram-user-id>
   WorkingDirectory=<absolute-path-to-this-repo>
   ExecStart=/usr/bin/env node src/index.js
   Restart=always
   RestartSec=5
   Environment=NODE_ENV=production

   [Install]
   WantedBy=multi-user.target
   EOF
   ```
2. Reload systemd:
   ```bash
   sudo systemctl daemon-reload
   ```
3. Enable and start the service:
   ```bash
   sudo systemctl enable --now agent-bridge-codex
   ```
4. Check status:
   ```bash
   systemctl status agent-bridge-codex
   ```
5. Follow logs:
   ```bash
   journalctl -u agent-bridge-codex -f
   ```

### Gemini service

Pattern is identical. Use `agent-bridge-gemini.service` and set `TELEGRAM_BOT_TOKEN_GEMINI` and `GEMINI_PROJECT_DIR`.

## Notes

- Each service keeps one session id in its own `.data/sessions.json`.
- If the process restarts, sessions are restored from that file.
- Processed Telegram update ids are stored in `.data/state.json`.
- Polling leases (locks) are stored in `.data/telegram-kind.lock`.
- Unauthorized Telegram users are ignored silently.
- Model overrides are stored in `.data/settings.json`.
- Trusted mode maps to Codex `--dangerously-bypass-approvals-and-sandbox` and Gemini `--approval-mode yolo`.
- `CLI_TIMEOUT_MS` is the hard cap for agent execution.
- `BRIDGE_ASYNC_ENABLED` (default: true) enables real-time progressive streaming.
- `OUTBOUND_MIN_INTERVAL_MS` (default: 1100) controls the outbox rate limit.

## Example .env

```env
TELEGRAM_BOT_TOKEN_CODEX=123456:replace-me
TELEGRAM_BOT_TOKEN_GEMINI=123456:replace-me
TELEGRAM_ALLOWED_USER_ID=123456789
BRIDGE_ROOT_DIR=/path/to/your/home
BRIDGE_PROJECT_DIR=/path/to/your/agent-bridge-repo
CODEX_PROJECT_DIR=/home/your-user/path/to/codex-repo
GEMINI_PROJECT_DIR=/home/your-user/path/to/gemini-repo
CODEX_COMMAND=codex
GEMINI_COMMAND=gemini
BRIDGE_ASYNC_ENABLED=true
POLL_INTERVAL_MS=1000
OUTBOUND_MIN_INTERVAL_MS=1100
CLI_TIMEOUT_MS=300000
GEMINI_FALLBACK_TIMEOUT_MS=120000
SESSION_STORE_PATH=.data/sessions.json
SETTINGS_STORE_PATH=.data/settings.json
BRIDGE_STATE_PATH=.data/state.json
```

## Test

```bash
npm test
```
