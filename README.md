# agent-bridge

Telegram bridge for Codex CLI, Antigravity CLI, and Claude Code CLI. TypeScript, streaming-first.

## What it does

Polls a Telegram bot for messages, routes them to the Codex, Antigravity, or Claude Code CLI, and streams responses back by editing a placeholder message in real time. Each bot runs as an independent systemd service from the same codebase.

## Features

- **Streaming responses** — edits a placeholder message as the CLI outputs, then replaces with the final result
- **Session continuity** — persists CLI session IDs per chat in SQLite so conversations resume across restarts
- **Kill switch** — `/stop` or `/cancel` aborts the running process immediately
- **Forum/topic support** — threads replies into the correct Telegram forum topic
- **Media group batching** — aggregates multi-photo messages into a single agent prompt
- **Model fallback** — automatically retries with a smaller model on capacity exhaustion (all bots)
- **Concurrency lock** — one execution per chat at a time (SQLite atomic lock, no race conditions)
- **Shared memory CLI** — local `agent-memory` commands store and recall durable project facts in SQLite
- **Rate limit handling** — automatic retry on Telegram 429 responses

## Requirements

- Node 22+
- One or more of `codex`, `agy`, `claude` CLI on `$PATH`
- `npm` on `$PATH`
- One Telegram bot per CLI backend, created via [@BotFather](https://t.me/BotFather)

## Setup

User-scope setup (run one or more, depending on which bots you want):

```bash
npm install
cp .env.codex.example .env.codex    # Codex bot
cp .env.antigravity.example .env.antigravity  # Antigravity bot
cp .env.claude.example .env.claude  # Claude Code bot
npm run setup:shared-memory
```

Then fill in the relevant token(s) and user ID:
- `TELEGRAM_BOT_TOKEN_CODEX` in `.env.codex`
- `TELEGRAM_BOT_TOKEN_ANTIGRAVITY` in `.env.antigravity`
- `TELEGRAM_BOT_TOKEN_CLAUDE` in `.env.claude`
- `TELEGRAM_ALLOWED_USER_IDS` in each file
- Shared memory instructions are written to `~/AGENTS.md`, `~/ANTIGRAVITY.md`, and `~/CLAUDE.md`
- `agent-memory` is installed as a shell wrapper in `~/.local/bin/agent-memory`

Run a single bot for development:

```bash
BRIDGE_ENV_FILE=.env.antigravity ./node_modules/.bin/tsx src/index.ts
BRIDGE_ENV_FILE=.env.claude ./node_modules/.bin/tsx src/index.ts
```

Important:
- Each service reads its own env file (`.env.codex`, `.env.antigravity`, `.env.claude`)
- `BRIDGE_ENV_FILE` must point at the bot-specific env file
- `BRIDGE_PROJECT_DIR` should point at the agent-bridge repo
- `CODEX_PROJECT_DIR` / `ANTIGRAVITY_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` may override the CLI working dir per bot

## Commands

| Command | Action |
|---------|--------|
| `/reset` | Clear the current CLI session (start fresh) |
| `/models` | Show and change the active model |
| `/memory` | Run a shared-memory CLI smoke test through the live CLI path |
| `/stop` | Abort the currently running CLI process |
| `/cancel` | Same as `/stop` |

All other text is forwarded to the CLI as a prompt.

## Configuration

Each service reads its own `.env` file. Only the token for that service's bot is required.

| Variable | Bot | Default | Description |
|----------|-----|---------|-------------|
| `TELEGRAM_BOT_TOKEN_CODEX` | Codex | — | Bot token from @BotFather |
| `TELEGRAM_BOT_TOKEN_CLAUDE` | Claude | — | Bot token from @BotFather |
| `TELEGRAM_BOT_TOKEN_ANTIGRAVITY` | Antigravity | — | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_USER_IDS` | All | — | Comma-separated Telegram user IDs. Also accepts legacy `TELEGRAM_ALLOWED_USER_ID`. |
| `CODEX_COMMAND` | Codex | `codex` | CLI binary path |
| `ANTIGRAVITY_COMMAND` | Antigravity | `agy` | CLI binary path |
| `CLAUDE_COMMAND` | Claude | `claude` | CLI binary path |
| `CODEX_MODEL_PREFERENCE` | Codex | — | Comma-separated model list; first = default, rest = fallbacks |
| `ANTIGRAVITY_MODEL_PREFERENCE` | Antigravity | — | Comma-separated model list; first = default, rest = fallbacks |
| `CLAUDE_MODEL_PREFERENCE` | Claude | — | Comma-separated model list; first = default, rest = fallbacks |
| `CODEX_PROJECT_DIR` | Codex | — | Working dir for CLI execution (overrides `BRIDGE_PROJECT_DIR`) |
| `ANTIGRAVITY_PROJECT_DIR` | Antigravity | — | Working dir for CLI execution (overrides `BRIDGE_PROJECT_DIR`) |
| `CLAUDE_PROJECT_DIR` | Claude | — | Working dir for CLI execution (overrides `BRIDGE_PROJECT_DIR`) |
| `DB_PATH` | All | `<project-dir>/.data/bridge.sqlite` | SQLite database path |
| `CLI_TIMEOUT_MS` | All | `300000` | Hard execution timeout (ms) |
| `CLI_IDLE_TIMEOUT_MS` | All | `60000` | Kill CLI after this many ms with no output |
| `FETCH_TIMEOUT_MS` | All | `45000` | Telegram API fetch timeout (ms) |
| `BRIDGE_ASYNC_ENABLED` | All | `true` | Enable streaming (disable for sync/plain mode) |
| `BRIDGE_EXECUTION_MODE` | All | `safe` | `safe` or `trusted` (bypasses CLI approval prompts) |
| `BRIDGE_PROJECT_DIR` | All | auto-detected | Repo path (used for default DB location) |

## Group and multi-user usage

The bot works in Telegram groups and supergroups. Two requirements:

1. **Disable Bot Privacy Mode** via BotFather: `/mybots → [your bot] → Bot Settings → Group Privacy → Turn off`. Without this, Telegram will not deliver non-command messages to the bot.
2. Commands work with or without the bot username suffix: `/reset` and `/reset@mybotname` are both recognised.

**Per-topic sessions:** In forum-style supergroups, each topic gets its own isolated CLI session. Sending in Topic A and Topic B maintains independent conversation threads with the agent.

**Multiple users:** Set `TELEGRAM_ALLOWED_USER_IDS` to a comma-separated list of Telegram user IDs. Each user in a private chat has their own isolated session. In groups with multiple allowed users, sessions are isolated per-user per-topic.

```
TELEGRAM_ALLOWED_USER_IDS=111111111,222222222
```

## Shared memory

`agent-bridge` ships a local `agent-memory` CLI backed by SQLite.

Default SQLite path:

```bash
$HOME/.agent-bridge/shared-memory/agent-memory.sqlite
```

Setup:

```bash
npm run setup:shared-memory
```

This writes a shell wrapper to `~/.local/bin/agent-memory` and updates:
- `~/AGENTS.md`
- `~/ANTIGRAVITY.md`
- `~/CLAUDE.md`

The instructions tell each agent when to call `agent-memory recall`, `add`, `list`, `search`, `update`, and `delete`.

The bridge runtime database remains separate from the shared memory database.

## Systemd deployment

`sudo` is only required for the systemd install step. The installer prompts for each bot token and skips services whose token is left blank.

```bash
npm run setup:shared-memory
sudo bash scripts/install.sh
```

Or copy manually (include only the services you want):

```bash
sudo cp systemd/agent-bridge-antigravity.service /etc/systemd/system/
sudo cp systemd/agent-bridge-codex.service /etc/systemd/system/
sudo cp systemd/agent-bridge-claude.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agent-bridge-antigravity agent-bridge-codex agent-bridge-claude
```

Follow logs:

```bash
journalctl -u agent-bridge-antigravity -f
journalctl -u agent-bridge-codex -f
journalctl -u agent-bridge-claude -f
```

To update an existing deployment (updates npm packages, Claude Code CLI, and restarts services):

```bash
sudo bash scripts/install-deployment.sh
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
| `<chatId>` | — | Per-chat row; holds session IDs and execution lock |
| `$polling:codex` / `:antigravity` / `:claude` | last update_id | Telegram polling offset per bot |
| `codex` / `antigravity` / `claude` (in `settings`) | model name | Per-bot model override (set via `/models`) |

Session IDs are stored as columns (`codex_session_id`, `gemini_session_id`, `claude_session_id`) on the chat row. The migration adds `claude_session_id` automatically on first run.
