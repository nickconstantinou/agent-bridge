# agent-bridge

Telegram bridge for Codex CLI and Gemini CLI. Single-user, TypeScript, streaming-first.

## What it does

Polls a Telegram bot for messages, routes them to the Codex or Gemini CLI, and streams responses back by editing a placeholder message in real time. Two bots run as separate systemd services from the same codebase.

## Features

- **Streaming responses** — edits a placeholder message as the CLI outputs, then replaces with the final result
- **Session continuity** — persists CLI session IDs per chat in SQLite so conversations resume across restarts
- **Kill switch** — `/stop` or `/cancel` aborts the running process immediately
- **Forum/topic support** — threads replies into the correct Telegram forum topic
- **Media group batching** — aggregates multi-photo messages into a single agent prompt
- **Gemini model fallback** — automatically retries with a smaller model on capacity exhaustion
- **Concurrency lock** — one execution per chat at a time (SQLite atomic lock, no race conditions)
- **Rate limit handling** — automatic retry on Telegram 429 responses

## Requirements

- Node 22+
- `codex` and/or `gemini` CLI on `$PATH`
- Two Telegram bots created via [@BotFather](https://t.me/BotFather)

## Setup

```bash
npm install
cp .env.codex.example .env.codex
cp .env.gemini.example .env.gemini
```

Then fill in:
- `TELEGRAM_BOT_TOKEN_CODEX` in `.env.codex`
- `TELEGRAM_BOT_TOKEN_GEMINI` in `.env.gemini`
- `TELEGRAM_ALLOWED_USER_ID` in both files

Run a single bot for development:

```bash
BRIDGE_ENV_FILE=.env.gemini ./node_modules/.bin/tsx src/index.ts
```

Important:
- Gemini service uses `.env.gemini`
- Codex service uses `.env.codex`
- `BRIDGE_ENV_FILE` must point at the bot-specific env file
- `BRIDGE_PROJECT_DIR` should point at the agent-bridge repo
- `CODEX_PROJECT_DIR` / `GEMINI_PROJECT_DIR` may override the CLI working dir per bot

## Commands

| Command | Action |
|---------|--------|
| `/reset` | Clear the current CLI session (start fresh) |
| `/models` | Show and change the active model |
| `/stop` | Abort the currently running CLI process |
| `/cancel` | Same as `/stop` |

All other text is forwarded to the CLI as a prompt.

## Configuration

Each service reads its own `.env` file:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN_CODEX` | Codex | — | Bot token |
| `TELEGRAM_BOT_TOKEN_GEMINI` | Gemini | — | Bot token |
| `TELEGRAM_ALLOWED_USER_ID` | Yes | — | Your Telegram user ID (everyone else is silently ignored) |
| `CODEX_COMMAND` | No | `codex` | CLI binary |
| `GEMINI_COMMAND` | No | `gemini` | CLI binary |
| `CODEX_MODEL` / `GEMINI_MODEL` | No | — | Default model |
| `DB_PATH` | No | `<project-dir>/.data/bridge.sqlite` | SQLite database path |
| `CLI_TIMEOUT_MS` | No | `300000` | Hard execution timeout (ms) |
| `BRIDGE_ASYNC_ENABLED` | No | `true` | Enable streaming (disable for sync/plain mode) |
| `BRIDGE_EXECUTION_MODE` | No | `safe` | `safe` or `trusted` |
| `POLL_INTERVAL_MS` | No | `1000` | Telegram long-poll idle interval (ms) |
| `BRIDGE_ROOT_DIR` | No | `$HOME` | Working directory for CLI execution |
| `BRIDGE_PROJECT_DIR` | No | auto-detected | Repo path (used for default DB location) |

## Systemd deployment

```bash
bash scripts/install.sh
```

Or copy manually:

```bash
sudo cp systemd/agent-bridge-gemini.service /etc/systemd/system/
sudo cp systemd/agent-bridge-codex.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agent-bridge-gemini agent-bridge-codex
```

Follow logs:

```bash
journalctl -u agent-bridge-gemini -f
journalctl -u agent-bridge-codex -f
```

## Development

```bash
npm test                    # run all tests (vitest)
npm test -- --watch         # watch mode
npm test -- test/cli.test.ts  # single file
```

## Architecture

```
Telegram Poll
    │
    ▼
handleUpdate()
    ├── /stop, /cancel → abortCliProcess() + db.unlock()
    ├── callback_query → model selector (inline keyboard)
    └── message → MediaGroupBuffer (1500ms flush)
                      │
                      ▼
               handleMessages()
                      ├── handleCommand() → /reset, /models
                      ├── db.tryLock()   → busy guard (rejects if already running)
                      └── sendMessageWithProgress()
                                │
                                ▼
                         executePromptAsync()
                                ├── runCliAsync() → streams onProgress chunks
                                │       └── StreamingUpdater.push()
                                │               ├── DM: debounced editMessageText (1500ms)
                                │               └── Group: sendMessageDraft (immediate)
                                └── StreamingUpdater.flush() → final editMessageText
```

## State

All state lives in a single SQLite database (`bridge_state` table, WAL mode):

| Row key | Value | Purpose |
|---------|-------|---------|
| `session:<chatId>:<bot>` | session ID | CLI session per chat, persisted across restarts |
| `lock:<chatId>` | `0` / `1` | Atomic execution lock |
| `$polling:<bot>` | last update_id | Telegram polling offset |
| `<bot>` | model name | Per-bot model override (set via `/models`) |
