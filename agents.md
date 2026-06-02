# Agent Bridge — Architecture

The **Agent Bridge** connects Telegram directly to AI CLI backends (Codex, Antigravity, Claude Code) using long-polling, structured JSON parsing, and per-chat execution locking.

---

## System Overview

```
Telegram Bot Long-Polling
         │
         ▼
┌─────────────────────────────────────────────────────┐
│                 BridgeBot.run()                     │
│  • Telegram long-polling (getUpdates, 30s timeout) │
│  • Per-chat locking (db.tryLock)                   │
│  • Async streaming execution path                  │
│  • CLI invocation → JSON → Telegram response        │
└──────────────────┬──────────────────────────────────┘
                   │
      ┌────────────┼────────────┐
      │            │            │
 Antigravity Bot   Codex Bot   Claude Bot
 (agy CLI)         (codex CLI) (claude CLI)
 (systemd)         (systemd)   (systemd)
```

Each bot is an **independent systemd service** sharing the same TypeScript source, distinguished only by `BRIDGE_ENV_FILE` pointing to their own `.env` file:

| Service | Env | Data Dir |
|---------|-----|----------|
| `agent-bridge-antigravity.service` | `.env.antigravity` | `.data-antigravity/` |
| `agent-bridge-codex.service` | `.env.codex` | `.data-codex/` |
| `agent-bridge-claude.service` | `.env.claude` | `.data-claude/` |

## Path Portability Rule

All future path-related changes must be machine agnostic. Prefer explicit environment variables first, then repo-relative or process-cwd defaults. Do not hardcode user names, home directories, deployment host paths, or local workspace layouts into source, tests, docs, or generated service defaults. Examples should use placeholders such as `/path/to/agent-bridge` unless they are describing an actual required Linux convention like `/etc/default`.

## Shared Memory

The bridge now uses a local shell-callable `agent-memory` CLI backed by SQLite.

- Default storage: SQLite
- Default path: `$HOME/.agent-bridge/shared-memory/agent-memory.sqlite`
- Wrapper command: `$HOME/.local/bin/agent-memory`
- Managed configs:
  - `~/AGENTS.md`
  - `~/GEMINI.md`
  - `~/CLAUDE.md`

Bootstrap:

```bash
npm run setup:shared-memory
```

Run this as the target user, not with `sudo`. The systemd install step is separate.

The setup script writes the `agent-memory` wrapper and updates the instruction files so agents recall before important decisions and store durable facts after learning them.

Verify:

```bash
npm run verify:shared-memory
```

Memory handshake prompt:

```text
On startup, check shared memory for relevant project facts and prior architectural decisions.
Record durable project facts in the local SQLite memory store.
Do not store ephemeral chat noise, tentative brainstorming, or repeated status updates.
Prefer updating existing memories over creating duplicates.
```

The setup script writes this as a managed markdown block so it can be updated later without replacing the rest of your home-level instruction files.

Smoke test:

```text
/memory
```

This runs a live CLI-path check by asking the bridged agent to use `agent-memory` and report whether the shared-memory tools are available.

---

## Data Storage — SQLite Only

All state lives in a single SQLite database per service instance (`DB_PATH` env var). There are no JSON state files, no lock files.

**Schema:**

```sql
CREATE TABLE bridge_state (
  chat_id               TEXT    PRIMARY KEY,
  codex_session_id      TEXT,
  antigravity_session_id TEXT,
  gemini_session_id      TEXT, -- legacy, backfilled into antigravity_session_id
  claude_session_id     TEXT,    -- added automatically by migration on first run
  active_execution_lock INTEGER NOT NULL DEFAULT 0,
  last_update_id        INTEGER NOT NULL DEFAULT 0,
  codex_consecutive_failures INTEGER NOT NULL DEFAULT 0,
  claude_consecutive_failures INTEGER NOT NULL DEFAULT 0,
  antigravity_consecutive_failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
```

| Row / key pattern | Purpose |
|-------------------|---------|
| `<chatId>` | Per-chat session IDs and execution lock |
| `$polling:antigravity` / `$polling:codex` / `$polling:claude` | Global polling offset per bot (sentinel rows) |
| `antigravity` / `codex` / `claude` (in `settings`) | Active model override set via `/models` |

**BridgeDb API:**

```typescript
db.getSession(chatId, bot)            // → string | null
db.setSession(chatId, bot, sessionId) // persists CLI session
db.tryLock(chatId)                    // → boolean (atomic UPDATE WHERE lock=0)
db.unlock(chatId)
db.getLastUpdateId(bot)               // → number
db.setLastUpdateId(bot, updateId)     // MAX semantics
db.getSetting(kind)                   // → string | null (model override)
db.setSetting(kind, value)
db.incrementFailures(chatId, bot)     // → number (increments failure counter)
db.resetFailures(chatId, bot)         // resets failure counter to 0
```

---

## Execution Paths

### Async (default — `BRIDGE_ASYNC_ENABLED=true`)

```
executePromptAsync() → runCliAsync() → onProgress(chunk) → StreamingUpdater → Telegram
                                                              └─ flush() → final edit
```

- Sends placeholder message immediately ("🤔 Thinking...")
- Streams text chunks via `onProgress` callback
- `StreamingUpdater` handles transport:
  - **DM (private):** debounced `editMessageText` (1500ms between edits)
  - **Group / supergroup:** `sendMessageDraft` immediately, no debounce
- Final `flush()` always calls `editMessageText` with the complete response
- "Message is not modified" errors on the final edit are silently ignored

### Sync (`BRIDGE_ASYNC_ENABLED=false`)

```
executePrompt() → runCli() → stdout → parseCliResult() → sendTelegramMessage()
```

- Blocks until CLI completes, then sends in one shot
- Supports MarkdownV2 with automatic fallback to escaped, then plain text

Both paths:
- Use hard timeout `cliTimeoutMs` (Codex defaults to 1 800 000ms / 30m; others default to 600 000ms / 10m)
- Use `cliIdleTimeoutMs` (Codex defaults to 240 000ms; Antigravity defaults to 480 000ms; Claude defaults to 180 000ms)
- Support model fallback on capacity exhaustion for any bot with multiple models configured
- Pass `chatId` to `runCli`/`runCliAsync` for the process registry

---

## Kill Switch (`/stop`, `/cancel`, `/reset`)

Intercepted in `handleUpdate` **before** `db.tryLock()`, so it works even when a lock is held:

- For `/stop` or `/cancel`:
  ```typescript
  abortCliProcess(chatKey)  // SIGKILL child, marks it in WeakSet
  db.unlock(chatKey)        // release any held lock
  sendTelegramMessage(...)  // "🛑 Execution aborted by user."
  ```
- For `/reset`:
  Aborts any active child process, releases the atomic lock, and clears the pending updates queue.

`runCli`/`runCliAsync` close handlers detect the `WeakSet` mark and resolve cleanly instead of rejecting, so the bridge continues polling normally.

## Session Failure Circuit Breaker

To prevent bots from getting stuck in an infinite resumption loop of a broken session (due to timeouts or process signal failures):
- The bridge increments the failure counter for the bot and chat when a run fails with a timeout or signal-killed error.
- If consecutive failures reach **2**, the bot's session ID is cleared (set to `null`) to trigger a fresh session on the next prompt.
- Any successful prompt execution resets the failure counter back to **0**.

---

## Lock Mechanism

Per-chat execution lock prevents concurrent CLI invocations:

```typescript
if (!db.tryLock(chatKey)) {
  await sendText(chatId, "⏳ System is currently busy...");
  return;
}
// ... execute ...
// always in finally:
db.unlock(chatKey);
```

`tryLock` is an atomic `UPDATE … WHERE active_execution_lock = 0` — no race condition possible. No file-based locks exist.

---

## CLI Invocation

### Build Phase (`buildCliInvocation`)

| Bot | Flags |
|-----|-------|
| **Codex** | `exec [resume <sessionId>]`, `--skip-git-repo-check`, `--model <m>`, `--json`, `--dangerously-bypass-approvals-and-sandbox` (trusted) |
| **Antigravity** | `--conversation <sessionId>` for resumes, `--dangerously-skip-permissions` (trusted), `--log-file <path>`, `--print <prompt>` |
| **Claude** | `--print`, `--model <m>`, `--resume <sessionId>`, `--dangerously-skip-permissions` (trusted), `--output-format json` |

Session handling differs per bot:
- **Codex / Claude** — pass `sessionId` directly; new sessions receive no session arg (the CLI creates one)
- **Antigravity** — new sessions receive no conversation arg; existing sessions use `--conversation <uuid>`. Agy requires all flags before `--print <prompt>` because `--print` consumes the prompt as its value. Agy does not accept a `--model` CLI flag; instead, model selection is applied by mapping the chosen model ID to its display label (e.g. `gemini-3.5-flash-high` to `Gemini 3.5 Flash (High)`) and writing it to `~/.gemini/antigravity-cli/settings.json` before execution.

### Parse Phase (`parseCliResult`)

**Codex** — scans JSONL stdout:
- `thread.started` → `sessionId`
- `item.completed` / `response.completed` → `finalText`
- `response.output_text.delta` → accumulates streaming chunks

**Antigravity** — returns plain stdout as text and resolves the conversation UUID from Agy logs/cache (explicit `--log-file` content when present, then recent `~/.gemini/antigravity-cli/log/*.log` files, then `~/.gemini/antigravity-cli/cache/last_conversations.json`). Additionally, the parser scans log contents for critical failures (e.g. `agent executor error:` or `error executing cascade step:`). If errors are found or the stdout response is empty, it throws a JSON-wrapped error message to trigger the model fallback mechanism. Extracted error texts are automatically de-duplicated to remove redundant colon-separated segments before display.

**Claude** — parses the last JSON object in stdout:
```json
{"type":"result","subtype":"success","session_id":"…","result":"response text"}
```
Falls back to plain-text if no JSON object with a `result` field is found.

### Error Messages

When a CLI exits non-zero, the error message includes `stderr || stdout.slice(-2000)` — so errors written to stdout (e.g. rate-limit banners) surface in full rather than appearing blank. The `toUserMessage()` helper trims the message to its first colon-delimited segment before forwarding it to Telegram.

### Fallback Detection

```typescript
export function isCapacityExhaustedError(err: Error): boolean {
  return msg.includes("MODEL_CAPACITY_EXHAUSTED") ||   // Codex
         msg.includes("No capacity available") ||
         msg.includes("rateLimitExceeded") ||           // Antigravity / Gemini APIs
         msg.includes("overloaded_error") ||            // Claude
         msg.includes("Overloaded");
}
```

When triggered, `getNextFallbackModel(currentModel, modelPreference[])` picks the next entry in the preference list for **any bot** that has multiple models configured. If no fallback remains the error propagates and is shown to the user.

---

## Model Preference

Configured via `*_MODEL_PREFERENCE` env var (comma-delimited):

```
ANTIGRAVITY_MODEL_PREFERENCE=gemini-3.5-flash-high,gemini-3.5-flash-medium,gemini-3.1-pro-high,gemini-3.1-pro-low  # mapped to display labels for settings.json overrides
CODEX_MODEL_PREFERENCE=gpt-5.5,gpt-5.5-mini,gpt-5.4,gpt-5.4-mini
CLAUDE_MODEL_PREFERENCE=claude-opus-4-7,claude-sonnet-4-6
```

- `modelPreference[0]` = default passed to CLI
- Rest = fallback chain tried in order on capacity errors
- `db.getSetting(kind)` overrides `modelPreference[0]` when a user has selected a model via `/models`

---

## Telegram-Specific Details

### Media Group Buffering

Telegram sends multi-photo albums as separate updates sharing a `media_group_id`. `MediaGroupBuffer` collects parts for 1500ms then fires a single `handleMessages()` call:

```typescript
const mediaBuffer = new MediaGroupBuffer({
  timeoutMs: 1500,
  onFlush: (groupId, messages) => this.handleMessages(messages)
});
```

### Forum / Topic Support

`extractThreadId(messages)` reads `messages[0].message_thread_id`. All outbound messages pass `message_thread_id` in the body so replies stay threaded correctly.

### Callback Query — Model Selector

Callback data format: `model:<kind>:<value>` or `model:<kind>:reset`

On receipt:
1. `db.setSetting(kind, value)` (or `null` for reset)
2. `answerCallbackQuery` with confirmation text
3. `editMessageText` to update the inline keyboard message

---

## State Machine (Per-Update)

```
getUpdates(offset)           ← long-poll, 30s timeout
         │
         ▼
handleUpdate(update)
  ├── callback_query → handleCallback() → model selector
  ├── auth check (from.id vs ALLOWED_USER_ID)
  ├── /stop or /cancel → abortCliProcess() + db.unlock() + ack
  └── message → MediaGroupBuffer.push()
                     │ (1500ms flush)
                     ▼
              handleMessages(msgs)
                ├── extractPromptText()    → null if starts with "/"
                ├── handleCommand()        → /reset, /models, /start
                ├── db.tryLock(chatKey)    → busy guard
                └── sendMessageWithProgress() or sendText()
                           │
                           ▼
                    executePromptAsync()
                           ├── buildCliInvocation()
                           ├── db.getSession()
                           ├── runCliAsync() + StreamingUpdater
                           ├── parseCliResult()
                           ├── db.setSession()
                           └── StreamingUpdater.flush()
                                      │
                                   finally
                                      │
                                 db.unlock(chatKey)
```

---

## Key File Structure

```
agent-bridge/
├── src/
│   ├── index.ts           — Entry: BridgeBot class, polling loop, DI, health scheduler wiring
│   ├── bridge.ts          — Auth, session helpers, re-exports from cli/db
│   ├── cli.ts             — runCli/runCliAsync, buildCliInvocation, parseCliResult,
│   │                        abortCliProcess, isCapacityExhaustedError, getNextFallbackModel
│   ├── db.ts              — openDb(), BridgeDb (SQLite via better-sqlite3)
│   ├── telegram.ts        — TelegramClient (HTTP), MediaGroupBuffer
│   ├── messageDelivery.ts — sendTelegramMessage, sendMessageWithProgress, StreamingUpdater
│   ├── render.ts          — splitTelegramText, escapeTelegramMarkdownV2, toTelegramEntitiesText
│   ├── commands.ts        — handleCommand(): /reset, /models, /start
│   ├── types.ts           — All shared interfaces (BridgeConfig, BotConfig, CliOptions, …)
│   └── health/
│       ├── types.ts       — HealthPlugin, HealthReport, CheckResult, HealthConfig, AutonomyLevel
│       ├── reporter.ts    — formatReport(): renders HealthReport as Telegram-friendly text
│       ├── scheduler.ts   — HealthScheduler: setInterval-based plugin runner
│       └── plugins/
│           ├── self.ts    — SelfPlugin: DB file existence + read liveness
│           └── external.ts — ExternalPlugin: spawns a command, parses stdout as HealthReport JSON
├── test/                  — Vitest test suite
├── docs/
│   └── PRD.md             — Full product requirements document
├── systemd/
│   ├── agent-bridge-antigravity.service
│   ├── agent-bridge-codex.service
│   └── agent-bridge-claude.service
├── scripts/
│   ├── install.sh          — First-time install (prompts for tokens, creates systemd units)
│   └── install-deployment.sh — Update existing deployment (npm, CLI update, service reload)
├── .env.antigravity       — Live Antigravity config (gitignored)
├── .env.codex             — Live Codex config (gitignored)
├── .env.claude            — Live Claude config (gitignored)
├── .env.*.example         — Template env files
└── agents.md              — This file
```

---

## Environment Variables

| Variable | Bot | Purpose |
|----------|-----|---------|
| `TELEGRAM_BOT_TOKEN_CODEX` | Codex | Bot token from @BotFather |
| `TELEGRAM_BOT_TOKEN_ANTIGRAVITY` | Antigravity | Bot token from @BotFather |
| `TELEGRAM_BOT_TOKEN_CLAUDE` | Claude | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_USER_IDS` | All | Comma-separated numeric Telegram user IDs. Legacy: `TELEGRAM_ALLOWED_USER_ID`. |
| `BRIDGE_ENV_FILE` | Service | Path to `.env.codex` / `.env.antigravity` / `.env.claude` |
| `CODEX_COMMAND` / `ANTIGRAVITY_COMMAND` / `CLAUDE_COMMAND` | Each | CLI binary path |
| `CODEX_MODEL_PREFERENCE` / `ANTIGRAVITY_MODEL_PREFERENCE` / `CLAUDE_MODEL_PREFERENCE` | Each | Comma-delimited model list; first = default, rest = fallbacks |
| `CODEX_PROJECT_DIR` / `ANTIGRAVITY_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` | Each | Override CLI working directory for this bot |
| `BRIDGE_EXECUTION_MODE` | All | `safe` (approval prompts) / `trusted` (bypass) |
| `BRIDGE_ASYNC_ENABLED` | All | `true` = streaming, `false` = sync (default: `true`) |
| `CLI_TIMEOUT_MS` | All | Hard timeout per CLI execution (default: 1 800 000ms for Codex; 600 000ms for others) |
| `CLI_IDLE_TIMEOUT_MS` | All | Kill CLI after this many ms with no stdout output (default: 240 000ms Codex; 480 000ms Antigravity; 180 000ms Claude) |
| `FETCH_TIMEOUT_MS` | All | Telegram API fetch timeout (default: 45 000ms) |
| `DB_PATH` | Each | Path to SQLite database (default: `<project-dir>/.data/bridge.sqlite`) |
| `BRIDGE_PROJECT_DIR` | All | Repo path (used for default `DB_PATH`) |
| `AGENT_BRIDGE_SOUL_PATH` | All | Optional persona contract path (default: `<project-dir>/SOUL.md`) |
| `AGENT_BRIDGE_SOUL_MODE` | All | `summary`, `full`, or `off` (default: `summary`) |
| `HEALTH_MONITOR_ENABLED` | All | `false` to disable health monitoring (default: `true`) |
| `HEALTH_MONITOR_CADENCE_SECONDS` | All | Seconds between health check runs (default: `3600`) |
| `HEALTH_MONITOR_AUTONOMY` | All | `report` / `suggest` / `auto` (default: `report`) |
| `HEALTH_MONITOR_CHAT_ID` | All | Telegram chat ID for health reports; if unset, logs to stdout |
| `HEALTH_CONTENT_CRAWLER_ENABLED` | All | `1` to enable the content-crawler external plugin (default: `0`) |
| `HEALTH_CONTENT_CRAWLER_SCRIPT` | All | Path to content-crawler health check script |

---

## Health Monitoring Plugin System

A `HealthScheduler` starts alongside the bots and calls each registered `HealthPlugin.check()` at the configured cadence. Results are formatted with emoji status indicators and sent via the first active bot's Telegram client to `HEALTH_MONITOR_CHAT_ID`.

### Plugin interface

```typescript
interface HealthPlugin {
  name: string;
  check(): Promise<HealthReport>;
}

interface HealthReport {
  pluginName: string;
  status: "green" | "amber" | "red";
  checks: CheckResult[];
  summary: string;
  timestamp: string;
}

interface CheckResult {
  name: string;
  status: "green" | "amber" | "red";
  message: string;
  value?: string | number;
}
```

### Built-in plugins

**`SelfPlugin`** — always registered. Checks DB file existence and runs a read query as a liveness probe.

**`ExternalPlugin`** — wraps any shell command. Spawns the command with `spawnSync`, expects exit 0 and a `HealthReport` JSON on stdout. Returns a synthetic red report on non-zero exit or invalid JSON.

### Adding a plugin

Register a second `ExternalPlugin` in `src/index.ts`:

```typescript
healthPlugins.push(new ExternalPlugin({
  name: "my-system",
  command: "python3",
  args: ["/path/to/my_health.py"],
  timeoutMs: 30_000,
}));
```

The external script must exit 0 and print a valid `HealthReport` JSON to stdout.

**Minimal script template:**

```python
#!/usr/bin/env python3
import json
from datetime import datetime

def check_my_thing():
    # return {"name": "...", "status": "green"|"amber"|"red", "message": "..."}
    return {"name": "ping", "status": "green", "message": "ok"}

checks = [check_my_thing()]
worst = "red" if any(c["status"] == "red" for c in checks) else \
        "amber" if any(c["status"] == "amber" for c in checks) else "green"

print(json.dumps({
    "pluginName": "my-system",
    "status": worst,
    "checks": checks,
    "summary": "All good" if worst == "green" else "Issues detected",
    "timestamp": datetime.now().isoformat(),
}))
```

### Content-crawler POC

`~/content-crawler/scripts/health_check.py` is the reference implementation. Enable it with:

```bash
HEALTH_CONTENT_CRAWLER_ENABLED=1
HEALTH_MONITOR_CHAT_ID=<your-chat-id>
```

Checks it performs:

| Check | Amber threshold | Red threshold |
|-------|----------------|---------------|
| `queue-depth` | 100 pending items | 500 pending items |
| `failed-items` | 5 failed items | 20 failed items |
| `stale-workers` | — | Any item in `processing` > 30 min |
| `signal-feed` | Feed file older than 6 h | File missing |
| `disk-space` | < 2 GB free | < 0.5 GB free |

---

## Operational Notes

### Restart Process

No lock files to clear. Just restart the service:

```bash
sudo systemctl restart agent-bridge-antigravity
sudo systemctl restart agent-bridge-codex
sudo systemctl restart agent-bridge-claude
```

The SQLite polling offset persists across restarts — no re-processing of old updates.

### Monitoring

```bash
systemctl status agent-bridge-antigravity agent-bridge-codex agent-bridge-claude
journalctl -u agent-bridge-antigravity -f
journalctl -u agent-bridge-codex -f
journalctl -u agent-bridge-claude -f
```

### 409 Conflict ("terminated by other getUpdates request")

Only one process per bot token is allowed to poll. If this appears, another instance of the same bot is running. Find and kill it:

```bash
ps aux | grep "tsx src/index.ts"
kill -9 <pid>
sudo systemctl start agent-bridge-claude   # or -antigravity / -codex
```

### Idle Timeout

Both `runCli` and `runCliAsync` apply `CLI_IDLE_TIMEOUT_MS` (default 60 000ms). If the CLI produces no stdout for that duration it is killed with SIGTERM → SIGKILL (5s grace). Use `/stop` to abort a runaway process manually.
