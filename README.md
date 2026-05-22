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
- **Shared skills installer** — optional SDLC skills can be installed across Codex, Antigravity, and Claude Code
- **SOUL.md design** — proposed bridge-level persona contract for consistent voice, values, boundaries, and workflow across agents
- **Rate limit handling** — automatic retry on Telegram 429 responses

## Requirements

- Node 22+
- One or more of `codex`, `agy`, `claude` CLI on `$PATH`
- `npm` on `$PATH`
- One Telegram bot per CLI backend, created via [@BotFather](https://t.me/BotFather)

## Setup

**Recommended — let the installer generate env files:**

```bash
npm run setup:shared-memory
sudo bash scripts/install.sh
```

The installer prompts for bot tokens, user IDs, and paths, then writes `.env.codex`, `.env.antigravity`, and `.env.claude` from the example templates and installs the systemd services.

**Manual setup** (dev / no-systemd):

```bash
npm install
cp .env.codex.example .env.codex
cp .env.antigravity.example .env.antigravity
cp .env.claude.example .env.claude
npm run setup:shared-memory
```

Then fill in the relevant token(s) and paths in each file:
- `TELEGRAM_BOT_TOKEN_*` — bot token from @BotFather
- `TELEGRAM_ALLOWED_USER_IDS` — your Telegram numeric user ID
- `BRIDGE_ROOT_DIR` / `BRIDGE_PROJECT_DIR` — deployment paths supplied by environment or installer
- `*_COMMAND` — absolute path to each CLI binary (use `which codex`, `which agy`, `which claude`)
- `*_PROJECT_DIR` — working directory passed to the CLI (optional; defaults to `BRIDGE_PROJECT_DIR`)
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
| `/skills` | List bundled shared skills and install/repair commands |
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
| `DB_PATH` | All | `.data-<bot>/bridge.sqlite` | SQLite database path |
| `CLI_TIMEOUT_MS` | All | `300000` | Hard execution timeout (ms) |
| `CLI_IDLE_TIMEOUT_MS` | All | `60000` | Kill CLI after this many ms with no output |
| `FETCH_TIMEOUT_MS` | All | `45000` | Telegram API fetch timeout (ms) |
| `POLL_INTERVAL_MS` | All | `1000` | Telegram long-poll interval (ms) |
| `AGENT_MEMORY_DB_PATH` | All | `~/.agent-bridge/shared-memory/agent-memory.sqlite` | Path to shared agent memory database |
| `AGENT_BRIDGE_SOUL_PATH` | All | `$BRIDGE_PROJECT_DIR/SOUL.md` | Optional SOUL.md persona contract injected into each CLI prompt |
| `AGENT_BRIDGE_SOUL_MODE` | All | `summary` | `summary`, `full`, or `off` persona injection mode |
| `BRIDGE_ASYNC_ENABLED` | All | `true` | Enable streaming (disable for sync/plain mode) |
| `BRIDGE_EXECUTION_MODE` | All | `safe` | `safe` or `trusted` (bypasses CLI approval prompts) |
| `BRIDGE_PROJECT_DIR` | All | current working directory | Repo path (used as default CLI working dir and DB location) |
| `BRIDGE_ROOT_DIR` | All | `$HOME` | Fallback working dir when no `*_PROJECT_DIR` is set |

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

## Shared skills

`agent-bridge` also bundles reusable SDLC skills:

- `requirements-to-acceptance` — turn vague requests into requirements, non-goals, acceptance criteria, and verification steps
- `risk-based-test-strategy` — choose test depth based on blast radius and regression risk
- `red-green-refactor-tdd` — use red-green-refactor TDD for features, bug fixes, behavior changes, and refactoring
- `release-readiness-review` — check release, rollback, observability, docs, and post-release validation readiness

Skills are stored once under:

```bash
~/.agents/skills/<skill-name>
```

Then they are projected into each CLI's native skills directory:

```bash
~/.codex/skills/<skill-name>
~/.gemini/antigravity/skills/<skill-name>
~/.claude/skills/<skill-name>
```

Global instruction files are not modified by the skills installer.
Fresh and deployment installs project all bundled skills into native CLI directories by default. Set `AGENT_BRIDGE_SKILLS=none` to skip this.

Manage skills manually:

```bash
npm run skills -- list
npm run skills -- install red-green-refactor-tdd
npm run skills -- verify
npm run skills -- uninstall red-green-refactor-tdd
```

Native CLI entries are symlinks by default. Use copy mode if a CLI does not discover symlinked skills correctly:

```bash
npm run skills -- install red-green-refactor-tdd --force --link-mode copy
```

During installation, override the default bundled set with a comma-separated list for non-interactive setup:

```bash
AGENT_BRIDGE_SKILLS=red-green-refactor-tdd,risk-based-test-strategy sudo bash scripts/install.sh
```

Optional install variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_BRIDGE_SKILLS` | all bundled skills | Comma-separated bundled skills to install during `install.sh` or `install-deployment.sh`; use `none` to skip. |
| `AGENT_BRIDGE_SKILL_LINK_MODE` | `symlink` | Native CLI projection mode: `symlink` or `copy`. |

If verification reports stale symlinks or missing native entries, repair them with:

```bash
npm run skills -- verify --fix
```

## SOUL.md design

`SOUL.md` is the proposed bridge-level persona contract for all CLI-backed agents.

It should be runtime-injected by the bridge on every turn, including the first prompt after `/reset`, rather than written into `AGENTS.md`, `ANTIGRAVITY.md`, or `CLAUDE.md`.

The intended schema has 9 sections:

1. Identity — who the agent is, not just what it does
2. Values — decision-making when rules do not cover the case
3. Communication Style — tone, length, and formality
4. Expertise — specific tools and domains
5. Boundaries — rules that hold under pressure
6. Workflow — step-by-step process for tasks
7. Tool Usage — when and how to use tools
8. Memory Policy — what persists and what gets wiped
9. Example Interactions — concrete examples of good behaviour

See [`docs/soul.md`](docs/soul.md) for the full design, runtime injection order, reset behaviour, and suggested configuration.

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

Session IDs are stored as columns (`codex_session_id`, `antigravity_session_id`, legacy `gemini_session_id`, `claude_session_id`) on the chat row. The migration adds `antigravity_session_id` and backfills it from legacy `gemini_session_id` automatically on first run.

Antigravity session capture follows the same durable pattern as Codex, but Agy exposes the ID differently:

1. First turn runs `agy [flags] --print <prompt>` with no `--conversation` flag. Agy requires `--print` immediately before the prompt because it consumes the prompt as its flag value.
2. The bridge extracts the conversation UUID from Agy's explicit log output when available.
3. Because `--log-file` is not always honored by current Agy builds, the bridge also checks `~/.gemini/antigravity-cli/log/*.log` for recent `Created conversation ...` / `Print mode: conversation=...` lines.
4. If logs are not available, it falls back to `~/.gemini/antigravity-cli/cache/last_conversations.json` for the active working directory.
5. Later turns resume explicitly with `agy --conversation <uuid> [flags] --print <prompt>`.
