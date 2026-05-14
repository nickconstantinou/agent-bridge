# Agent Bridge — Architecture

The **Agent Bridge** connects Telegram directly to AI CLI backends (Codex, Gemini) using long-polling, structured JSON parsing, and per-chat execution locking.

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
└────────────────────┬────────────────────────────────┘
                     │
         ┌───────────┴────────────┐
         │                        │
    Gemini Bot              Codex Bot
   (gemini CLI)           (codex CLI)
   (systemd)              (systemd)
```

Each bot is an **independent systemd service** sharing the same TypeScript source, distinguished only by `BRIDGE_ENV_FILE` pointing to their own `.env` file:

| Service | Env | Data Dir |
|---------|-----|----------|
| `agent-bridge-gemini.service` | `.env.gemini` | `.data-gemini/` |
| `agent-bridge-codex.service` | `.env.codex` | `.data-codex/` |

## Shared MCP Memory

The bridge can configure a loosely coupled MCP memory provider for external CLIs without changing the bridge runtime.

- Default provider: `knowledgegraph-mcp`
- Default storage: SQLite
- Default path: `$HOME/.agent-bridge/shared-memory/knowledgegraph.sqlite`
- Managed configs:
  - `~/.codex/config.toml`
  - `~/.gemini/settings.json`
  - `~/.claude.json`

Bootstrap:

```bash
npm run setup:shared-memory
```

Verify:

```bash
npm run verify:shared-memory
```

Memory handshake prompt:

```text
On startup, check shared memory for relevant project facts and prior architectural decisions.
Record durable project facts as entities, relations, or observations.
Do not store ephemeral chat noise, tentative brainstorming, or repeated status updates.
Prefer updating existing entities over creating duplicates.
```

---

## Data Storage — SQLite Only

All state lives in a single SQLite database per service instance (`DB_PATH` env var). There are no JSON state files, no lock files.

**Schema:**

```sql
CREATE TABLE bridge_state (
  chat_id               TEXT    PRIMARY KEY,
  codex_session_id      TEXT,
  gemini_session_id     TEXT,
  active_execution_lock INTEGER NOT NULL DEFAULT 0,
  last_update_id        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
```

| Row / key pattern | Purpose |
|-------------------|---------|
| `<chatId>` | Per-chat session IDs and execution lock |
| `$polling:gemini` / `$polling:codex` | Global polling offset per bot (sentinel rows) |
| `gemini` / `codex` (in `settings`) | Active model override set via `/models` |

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
- Use `idleTimeoutMs: null` (no idle timeout; typing indicator provides liveness)
- Support model fallback on capacity exhaustion
- Pass `chatId` to `runCli`/`runCliAsync` for the process registry

---

## Kill Switch (`/stop`, `/cancel`)

Intercepted in `handleUpdate` **before** `db.tryLock()`, so it works even when a lock is held:

```typescript
abortCliProcess(chatKey)  // SIGKILL child, marks it in WeakSet
db.unlock(chatKey)        // release any held lock
sendTelegramMessage(...)  // "🛑 Execution aborted by user."
```

`runCli`/`runCliAsync` close handlers detect the `WeakSet` mark and resolve cleanly instead of rejecting, so the bridge continues polling normally.

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
| **Gemini** | `--model <m>`, `--resume <sessionId>`, `--yolo` (trusted), `--prompt <text>` |

### Parse Phase (`parseCliResult`)

**Codex** — scans JSONL stdout:
- `thread.started` → `sessionId`
- `item.completed` / `response.completed` → `finalText`
- `response.output_text.delta` → accumulates streaming chunks

**Gemini** — strips ANSI codes, extracts `[session:…]` marker for `sessionId`, remainder is text.

### Error Messages

When a CLI exits non-zero, the error message includes `stderr || stdout.slice(-2000)` — so errors written to stdout (e.g. Codex rate-limit banners) surface in full rather than appearing blank.

### Fallback Detection

```typescript
export function isCapacityExhaustedError(err: Error): boolean {
  return msg.includes("MODEL_CAPACITY_EXHAUSTED") ||
         msg.includes("No capacity available") ||
         msg.includes("rateLimitExceeded");
}
```

When triggered (Gemini only), `getNextFallbackModel(currentModel, modelPreference[])` picks the next entry in the preference list. If no fallback remains the error propagates and is shown to the user.

---

## Model Preference

Configured via `*_MODEL_PREFERENCE` env var (comma-delimited):

```
GEMINI_MODEL_PREFERENCE=auto-gemini-3,auto,flash
CODEX_MODEL_PREFERENCE=gpt-5.5,gpt-5.5-mini,gpt-5.4,gpt-5.4-mini
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
│   ├── index.ts           — Entry: BridgeBot class, polling loop, DI
│   ├── bridge.ts          — Auth, session helpers, re-exports from cli/db
│   ├── cli.ts             — runCli/runCliAsync, buildCliInvocation, parseCliResult,
│   │                        abortCliProcess, isCapacityExhaustedError, getNextFallbackModel
│   ├── db.ts              — openDb(), BridgeDb (SQLite via better-sqlite3)
│   ├── telegram.ts        — TelegramClient (HTTP), MediaGroupBuffer
│   ├── messageDelivery.ts — sendTelegramMessage, sendMessageWithProgress, StreamingUpdater
│   ├── render.ts          — splitTelegramText, escapeTelegramMarkdownV2, toTelegramEntitiesText
│   ├── commands.ts        — handleCommand(): /reset, /models, /start
│   └── types.ts           — All shared interfaces (BridgeConfig, BotConfig, CliOptions, …)
├── test/                  — Vitest test suite (87 tests)
├── docs/
│   └── PRD.md             — Full product requirements document
├── systemd/
│   ├── agent-bridge-gemini.service
│   └── agent-bridge-codex.service
├── .env.gemini            — Live Gemini config (gitignored)
├── .env.codex             — Live Codex config (gitignored)
├── .env.*.example         — Template env files
└── agents.md              — This file
```

---

## Environment Variables

| Variable | Bot | Purpose |
|----------|-----|---------|
| `TELEGRAM_BOT_TOKEN_CODEX` / `_GEMINI` | Each | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_USER_ID` | Both | Numeric Telegram user ID (sole authorized user) |
| `BRIDGE_ENV_FILE` | Service | Path to `.env.codex` / `.env.gemini` |
| `CODEX_COMMAND` / `GEMINI_COMMAND` | Each | CLI binary path |
| `CODEX_MODEL_PREFERENCE` / `GEMINI_MODEL_PREFERENCE` | Each | Comma-delimited model list; first = default, rest = fallbacks |
| `BRIDGE_EXECUTION_MODE` | Both | `safe` (approval prompts) / `trusted` (bypass) |
| `BRIDGE_ASYNC_ENABLED` | Both | `true` = streaming, `false` = sync (default: `true`) |
| `CLI_TIMEOUT_MS` | Both | Hard timeout per CLI execution (default: 300000) |
| `POLL_INTERVAL_MS` | Both | Idle sleep between empty poll cycles (default: 1000) |
| `DB_PATH` | Each | Path to SQLite database (default: `<project-dir>/.data/bridge.sqlite`) |
| `BRIDGE_ROOT_DIR` | Both | Working directory for CLI execution (default: `$HOME`) |
| `BRIDGE_PROJECT_DIR` | Both | Repo path (used for default `DB_PATH`) |

---

## Operational Notes

### Restart Process

No lock files to clear. Just restart the service:

```bash
sudo systemctl restart agent-bridge-gemini
sudo systemctl restart agent-bridge-codex
```

The SQLite polling offset persists across restarts — no re-processing of old updates.

### Monitoring

```bash
systemctl status agent-bridge-gemini agent-bridge-codex
journalctl -u agent-bridge-gemini -f
journalctl -u agent-bridge-codex -f
```

### 409 Conflict ("terminated by other getUpdates request")

Only one process per bot token is allowed to poll. If this appears, another instance of the same bot is running. Find and kill it:

```bash
ps aux | grep "tsx src/index.ts"
kill -9 <pid>
sudo systemctl start agent-bridge-gemini
```

### Async Path — No Idle Timeout

`runCliAsync` passes `idleTimeoutMs: null`. The typing indicator (sent every 4.5s) provides liveness. Use `/stop` to abort a runaway process.
