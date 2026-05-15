# Agent-Bridge PRD: Telegram CLI Bridge

## 1. Concept & Vision

**What it does:** Bridges Telegram messages to CLI-based AI coding agents (Codex, Gemini), enabling real-time conversational coding through a Telegram bot.

**Core experience:** A user sends a prompt via Telegram → the bridge spawns a CLI agent → responses stream back via real-time Telegram message editing.

**What makes it different:** It's a thin, reliable bridge — not an agent itself. It handles Telegram polling, rate limiting, message batching, session management, and process lifecycle so the CLI agent can focus on being smart.

---

## 2. Architecture

```
┌─────────────────┐     ┌──────────────────────────────────────────┐
│   Telegram      │     │           Agent Bridge                    │
│   User ────────►│     │                                          │
│                 │◄────│  TelegramClient ◄── Long Poll            │
│                 │     │         │                                 │
│   ◄────────────│     │         ▼                                 │
│   Responses    │     │  BridgeBot                                │
│                 │     │    ├── handleUpdate()                     │
│                 │     │    │   ├── /stop → abortCliProcess()     │
│                 │     │    │   └── message → MediaGroupBuffer    │
│                 │     │    ├── executePromptAsync() [streaming]  │
│                 │     │    └── executePrompt() [sync fallback]   │
│                 │     │         │                                 │
│                 │     │         ▼                                 │
│                 │     │  runCliAsync / runCli                    │
│                 │     │    ├── spawn CLI process                  │
│                 │     │    ├── activeProcesses registry           │
│                 │     │    ├── stream via onProgress             │
│                 │     │    └── kill on timeout / abort           │
│                 │     │         │                                 │
│                 │     │         ▼                                 │
│                 │     │  sendMessageWithProgress                 │
│                 │     │    └── sendTelegramMessage (final send)  │
└─────────────────┘     └──────────────────────────────────────────┘
         │                            │
         ▼                            ▼
┌─────────────────┐         ┌─────────────────────────┐
│ Telegram API    │         │ CLI Backend             │
│ (api.telegram)  │         │ (codex / gemini)        │
└─────────────────┘         └─────────────────────────┘
```

---

## 3. Message Processing Flow

```
Telegram Update
    │
    ▼
handleUpdate()
    ├── callback_query → model selector (inline keyboard)
    ├── /stop or /cancel → abortCliProcess() → db.unlock() (guarded) + abortedChats.add()
    └── message → isAuthorizedMessage() → MediaGroupBuffer (1500ms flush)
                                                    │
                                                    ▼
                                           handleMessages()
                                                    ├── abortedChats.delete(chatKey)
                                                    ├── extractPromptText()  → ignore commands
                                                    ├── handleCommand()      → /reset, /models
                                                    ├── db.tryLock()         → enqueue (max 5) or execute
                                                    └── sendMessageWithProgress(isAborted)
                                                                │
                                                                ▼
                                                       executePromptAsync()
                                                                ├── buildCliInvocation()
                                                                ├── db.getSession()
                                                                ├── runCliAsync() → onProgress
                                                                ├── parseCliResult()
                                                                └── db.setSession()
                                                    finally: db.unlock() → drainQueue()
```

---

## 4. Features

### 4.1 Message Delivery

`sendMessageWithProgress` sends a typing indicator while the CLI runs, then sends the final response via `sendTelegramMessage`. If `/stop` was called during execution, `isAborted()` returns true and the final send is suppressed to prevent double-messages.

### 4.2 Session Persistence

| Bot | Resume flag |
|-----|-------------|
| Codex | `exec resume <sessionId>` |
| Gemini | `--resume <sessionId>` |

Sessions are stored per chat in SQLite and restored across service restarts. `/reset` clears the session.

### 4.3 Process Registry & Kill Switch

`runCli` and `runCliAsync` register each child process in `activeProcesses: Map<chatId, ChildProcess>`. `abortCliProcess(chatId)` marks the child in a `WeakSet` and SIGKILLs it. The close handler detects the abort mark and resolves cleanly (no error propagation).

`/stop` and `/cancel` are intercepted in `handleUpdate` before `db.tryLock()`, so they work even when a lock is held.

### 4.4 Model Fallback

On `MODEL_CAPACITY_EXHAUSTED` / `No capacity available` / `rateLimitExceeded`, the bridge retries with the next model in the preference chain. Configured via `CODEX_MODEL_PREFERENCE` / `GEMINI_MODEL_PREFERENCE` (comma-separated, priority order):

**Codex** (ChatGPT account auth):
```
gpt-5.5 → gpt-5.4 → gpt-5.4-mini → (give up)
```

**Gemini**:
```
gemini-3.1-pro-preview → gemini-3.1-flash-lite-preview → gemini-2.5-pro → gemini-2.5-flash-lite → (give up)
```

The response is prepended with a warning notice when a fallback is used.

### 4.5 Concurrency Lock & Message Queue

`db.tryLock(chatId)` is an atomic SQLite `UPDATE … WHERE active_execution_lock = 0` — only one execution per chat at a time. Lock is released in a `finally` block which also calls `drainQueue(chatKey)`.

If a chat is busy, the incoming message is queued (max `MAX_QUEUE_DEPTH = 5`). The user receives a position notice. When execution finishes, `drainQueue` pops the next item via `setImmediate` and calls `handleMessages` with a synthetic message. If the queue is full, the user receives "⏳ Queue is full."

### 4.6 Rate Limit Handling

`TelegramClient.call()` retries automatically on HTTP 429 up to 2 times, sleeping `retry_after` seconds between attempts.

### 4.7 MediaGroup Batching

Photos sent as an album share a `media_group_id`. `MediaGroupBuffer` collects messages for 1500ms, then flushes them as a single `handleMessages` call so the agent sees the full context.

---

## 5. CLI Integration Matrix

| Bot | Session flag | JSON output flag | Trusted flag |
|-----|-------------|-----------------|-------------|
| Codex | `exec resume <id>` | `--json` | `--dangerously-bypass-approvals-and-sandbox` |
| Gemini | `--resume <id>` | `--prompt` (stream JSON) | `--yolo` |

### Timeout Configuration

| Setting | Default | Env variable |
|--------|---------|-------------|
| CLI hard timeout | 300s | `CLI_TIMEOUT_MS` |
| Idle timeout | Disabled | — |

---

## 6. Data Model

### BridgeConfig

```typescript
interface BridgeConfig {
  allowedUserId: string;
  serviceEnvFile: string | null;
  serviceKind: "codex" | "gemini" | null;
  pollIntervalMs: number;
  executionMode: "safe" | "trusted";
  cliTimeoutMs: number;
  asyncEnabled: boolean;
  dbPath: string;
  bots: {
    codex: BotConfig;
    gemini: BotConfig;
  };
}
```

### SQLite Schema (`bridge_state`)

```sql
CREATE TABLE bridge_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  active_execution_lock INTEGER NOT NULL DEFAULT 0
);
```

| Key pattern | Value | Purpose |
|-------------|-------|---------|
| `session:<chatId>:<bot>` | session ID | CLI session per chat |
| `lock:<chatId>` | — | Row used for atomic lock |
| `$polling:<bot>` | last update_id | Telegram polling offset |
| `<bot>` | model name | Per-bot model override |

---

## 7. File Structure

```
src/
├── index.ts          — Main entry, BridgeBot class, polling loop
├── cli.ts            — Process spawn, runCli/runCliAsync, abortCliProcess
├── telegram.ts       — TelegramClient (HTTP), MediaGroupBuffer
├── messageDelivery.ts — sendTelegramMessage, sendMessageWithProgress, StreamingUpdater
├── render.ts         — Text splitting, MarkdownV2, Telegram entities
├── bridge.ts         — Auth, session helpers, re-exports
├── db.ts             — BridgeDb (SQLite via better-sqlite3)
├── types.ts          — TypeScript interfaces
└── commands.ts       — /reset, /models (synchronous, returns string | null)

test/
├── cli.test.ts         — Process lifecycle, abort, fallback, timeouts
├── db.test.ts          — BridgeDb: sessions, locks, polling offset, settings
├── bridge.test.ts      — Auth, extractPromptText, handleCommand
├── messageDelivery.test.ts — Streaming, debounce, truncation, error edit
├── forum.test.ts       — message_thread_id threading
├── render.test.ts      — Text splitting, Markdown escaping
├── telegram.test.ts    — TelegramClient, MediaGroupBuffer
├── execution-paths.test.ts — Systemd service file, useAsync flag
├── systemd.test.ts     — Service file correctness
└── ...

systemd/
├── agent-bridge-codex.service
└── agent-bridge-gemini.service

docs/
└── PRD.md            — This file
```

---

## 8. Security Model

### Authorization

`TELEGRAM_ALLOWED_USER_ID` — only this Telegram user ID triggers executions. All other users are silently ignored.

### Execution Modes

| Mode | Codex flag | Gemini flag |
|------|-----------|-------------|
| `safe` | (none) | (none) |
| `trusted` | `--dangerously-bypass-approvals-and-sandbox` | `--yolo` |

---

## 9. Deployment

### Systemd

Two separate service files in `systemd/`. Each loads its own `.env` file via `BRIDGE_ENV_FILE`. Both share the same `tsx src/index.ts` entrypoint — bot selection is determined by which token is present in the env file.

### Database

Each service instance should have its own `DB_PATH` to avoid SQLite lock contention.

```
.data/bridge.sqlite       # shared / dev
.data-gemini/bridge.sqlite
.data-codex/bridge.sqlite
```

WAL mode is enabled on open for concurrent read access.

---

## 10. Error Handling

| Error | Handling |
|-------|----------|
| CLI hard timeout | Kill process, error edit on placeholder |
| CLI abort (`/stop`) | SIGKILL, resolve cleanly, bridge continues |
| Gemini capacity exhausted | Retry with fallback model, prepend warning |
| Telegram 429 | Auto-retry up to 2 times with `retry_after` delay |
| "Message is not modified" | No-op (not a real error) |
| Execution lock held | Reply "⏳ System is currently busy" |
| Parse error | Return raw stdout as text |

---

## 11. Known Limitations

- Single `allowedUserId` — no multi-user support
- Sessions are CLI thread IDs, not full conversation history
- Sync path (`BRIDGE_ASYNC_ENABLED=false`) available but not the default
- `abortCliProcess` SIGKILLs the top-level process only (not the full process group)
