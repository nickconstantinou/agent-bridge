# agent-bridge

Tiny single-user Telegram bridge for Codex CLI and Gemini CLI.

## Scope

- one shared repo, two separate service instances
- 2 Telegram bots: one for Codex, one for Gemini
- ignores unauthorized users silently
- text in, text out
- maintains one persisted session per bot
- simple commands: `/start`, `/models`, `/model <name>`, `/model reset`, `/reset`

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

If you want to install it from the repo copy directly:

```bash
sudo install -m 0644 systemd/agent-bridge-codex.service /etc/systemd/system/agent-bridge-codex.service
sudo systemctl daemon-reload
sudo systemctl enable --now agent-bridge-codex
```

### Gemini service

Create `/etc/systemd/system/agent-bridge-gemini.service` with the same pattern, but set:

- `Description=Telegram bridge for Gemini`
- `Environment=GEMINI_PROJECT_DIR=<absolute-path-to-gemini-repo>`
- `Environment=TELEGRAM_BOT_TOKEN_GEMINI=<gemini-bot-token>`
- `Environment=BRIDGE_ENV_FILE=<absolute-path-to-service-env-file>`

and use `agent-bridge-gemini` in the enable/status/log commands.

If you want to install it from the repo copy directly:

```bash
sudo install -m 0644 systemd/agent-bridge-gemini.service /etc/systemd/system/agent-bridge-gemini.service
sudo systemctl daemon-reload
sudo systemctl enable --now agent-bridge-gemini
```

Common commands:

```bash
sudo systemctl restart agent-bridge-codex
sudo systemctl stop agent-bridge-codex
sudo systemctl start agent-bridge-codex
```

### One-shot installer / updater

From the repo root:

```bash
./scripts/install.sh
```

This will:
- prompt for the required env vars if they are not already set
- write `/etc/default/agent-bridge-codex` and `/etc/default/agent-bridge-gemini`
- install dependencies
- install both systemd units
- reload systemd
- enable and start both services

If you already handled CLI installation, use:

```bash
./scripts/install.sh --skip-cli-install
```

You can also run it directly from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/nickconstantinou/agent-bridge/main/scripts/install.sh | bash
```

If `node` is not found under systemd, replace `ExecStart=/usr/bin/env node src/index.js` with the full node path from:

```bash
which node
```

## Notes

- Each service keeps one session id in its own `.data/sessions.json`.
- If the process restarts, sessions are restored from that file.
- Processed Telegram update ids are stored in `.data/state.json`.
- Set `BRIDGE_ROOT_DIR` and `BRIDGE_PROJECT_DIR` to move the bridge to another machine.
- If `BRIDGE_PROJECT_DIR` is omitted, it defaults under `BRIDGE_ROOT_DIR`.
- Unauthorized Telegram users are ignored silently.
- Model overrides are stored in `.data/settings.json`.
- Trusted mode maps to Codex `--dangerously-bypass-approvals-and-sandbox` and Gemini `--approval-mode yolo`.
- There is no separate policy file for trusted mode, the CLI flags are the permission boundary.
- `CLI_TIMEOUT_MS` is the hard cap, `CLI_IDLE_TIMEOUT_MS` resets whenever the CLI emits output.

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
POLL_INTERVAL_MS=1000
CLI_TIMEOUT_MS=300000
CLI_IDLE_TIMEOUT_MS=60000
GEMINI_FALLBACK_TIMEOUT_MS=120000
SESSION_STORE_PATH=.data/sessions.json
SETTINGS_STORE_PATH=.data/settings.json
BRIDGE_STATE_PATH=.data/state.json
```

## Test

```bash
npm test
```
