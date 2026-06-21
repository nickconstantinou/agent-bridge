# Agent-Bridge PRD: CLI Bridge Control Plane

## 1. Concept & Vision

**What it does:** Bridges Telegram and Discord messages to CLI-based AI coding agents (Codex, Antigravity/Gemini CLI, Claude Code), enabling real-time conversational coding, switchable interactive routing, health reporting, and policy-gated background engineering jobs.

**Core experience:** A user sends a prompt via Telegram or Discord → the bridge spawns the selected CLI agent → responses stream back through the same chat surface. Long-running worker jobs use Telegram commands and inline approvals to scan, plan, implement, open PRs, watch CI, and ask for merge decisions.

**What makes it different:** It's a thin, reliable bridge — not an agent itself. It handles chat transport, rate limiting, message batching, session management, process lifecycle, queue leases, and approval gates so the CLI agent can focus on reasoning and implementation.

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
│ Telegram API    │         │ CLI Backend                      │
│ (api.telegram)  │         │ (codex / antigravity / claude)   │
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
| Antigravity | `--resume <sessionId>` |
| Claude | `--resume <sessionId>` |

Sessions are stored per chat in SQLite and restored across service restarts. Every user and assistant turn is also persisted to `conversation_turns`, surviving restarts and CLI switches. `/reset` clears the CLI session **and** all conversation turns + summaries for the chat.

### 4.3 Process Registry & Kill Switch

`runCli` and `runCliAsync` register each child process in `activeProcesses: Map<chatId, ChildProcess>`. `abortCliProcess(chatId)` marks the child in a `WeakSet` and SIGKILLs it. The close handler detects the abort mark and resolves cleanly (no error propagation).

`/stop` and `/cancel` are intercepted in `handleUpdate` before `db.tryLock()`, so they work even when a lock is held.

### 4.4 Conversation Persistence & Compaction

Every user message and assistant response is persisted to SQLite in `conversation_turns`. The table survives service restarts and CLI switches — replacing the previous in-memory `recentTurns` / `chatTurns` Maps.

`buildConvContext(chatKey, maxChars)` composes the latest compact summary (if any) plus recent raw turns into a context preamble prepended to CLI prompts. It walks turns newest-first, accumulating character count, and stops when the char budget is exhausted. The summary always takes priority and is included even if it alone exceeds the budget. Default budget: `BRIDGE_CONTEXT_MAX_CHARS = 8_000` (~2K tokens); override via env var.

**`/compact`** — Creates a semantic checkpoint and starts a fresh CLI session. The engine:
1. Loads all un-compacted turns for the chat key via `getConvTurnsForCompaction` (`id > latest_summary.range_end_turn_id`).
2. Chunks the loaded turns by prompt budget (`COMPACT_CHUNK_MAX_CHARS = 6_500`).
3. Summarises each chunk with `buildCompactSummaryPrompt` in single-shot print mode (`sessionId: null`) with a 60s `Promise.race` timeout.
4. If multiple chunks or a previous summary exists, reduce-merges the previous compact summary plus chunk summaries into one durable `summary_md`.
5. If any summariser call fails or returns empty output, stores a tombstone covering the exact loaded turn range instead of pruning uncovered turns.
6. Stores the final summary via `addConvSummary`, then prunes raw turns up to `endId` via `pruneConvTurns`.
7. Clears the `ctx_suppress` flag and the CLI session — next prompt starts a fresh CLI seeded with the new summary.

**`/context`** — Reports current conversation state: turn count, pending queue depth, last turn timestamp, and last compact time. Reads from `getConvStatus` and `getLatestConvSummary`. If stored turns exceed 100, it appends `High turn count - consider /compact`.

**`/reset`** — Preserves conversation data but suppresses context injection. Sets a `ctx_suppress:<chatKey>` flag in the `settings` table and clears the CLI session. The next prompt starts a fresh CLI with no history preamble. The `ctx_suppress` flag is automatically cleared when `/compact` runs.

### 4.4a Model Fallback

On `MODEL_CAPACITY_EXHAUSTED` / `No capacity available` / `rateLimitExceeded`, the bridge retries with the next model in the preference chain. Configured via `CODEX_MODEL_PREFERENCE` / `ANTIGRAVITY_MODEL_PREFERENCE` / `CLAUDE_MODEL_PREFERENCE` (comma-separated, priority order):

**Codex**:
```
gpt-5.5 → gpt-5.4-mini → gpt-5.4 → gpt-5.3-codex → gpt-5.2 → (give up)
```

**Antigravity**:
```
gemini-3.5-flash-high → gemini-3.5-flash-medium → gemini-3.1-pro-high → gemini-3.1-pro-low → (give up)
```

**Claude**:
```
claude-sonnet-4-6 → claude-opus-4-7 → (give up)
```

The response is prepended with a warning notice when a fallback is used.

> **Antigravity note**: Agy does not accept a `--model` CLI flag. Model selection (including fallback) is applied by mapping the chosen model ID (e.g. `gemini-3.5-flash-high`) to its display label (e.g. `Gemini 3.5 Flash (High)`) and writing that value into `~/.gemini/antigravity-cli/settings.json` before the process is spawned. Resetting to default removes the `model` key so Agy falls back to its own default.

### 4.4b Agent Context Helper

CLI agents spawned by the bridge receive three environment variables injected by `buildCliInvocation`:

| Variable | Value |
|---|---|
| `AGENT_BRIDGE_CONTEXT_AVAILABLE` | `"1"` — signals helper is present |
| `AGENT_BRIDGE_CONTEXT_COMMAND` | Absolute path to `bin/agent-bridge-context` |
| `AGENT_BRIDGE_CONTEXT_DB` | DB path for the current bot instance |
| `AGENT_BRIDGE_CHAT_KEY` | Current chat key (`chatId:threadId`) |

The `agent-bridge-context` binary (in `bin/`) opens the DB **read-only** and outputs:
- `agent-bridge-context` (no args) — latest compact summary
- `agent-bridge-context --recent [N]` — N most recent turns (default 20, max 100)

This gives CLI agents queryable access to bridge conversation history without any MCP server. The bridge prompt preamble tells agents when `AGENT_BRIDGE_CONTEXT_AVAILABLE=1` and how to invoke it.

### 4.5 Interactive Bot CLI-to-CLI Fallback

In the unified interactive bot (switchable CLI), if all model fallbacks of the user's preferred CLI are exhausted and the bot encounters a capacity/rate-limit error (e.g. `session limit` or `resets`), it automatically:
1. Advances to the next CLI in the preference chain (default order: `codex` → `claude` → `antigravity`, configurable via `INTERACTIVE_CLI_CHAIN` in environment variables).
2. Notifies the user of the switch and updates the Telegram commands menu to match the active CLI.
3. Prepends a context preamble (latest compact summary + recent turns from SQLite) to the prompt and retries the execution on the fallback CLI engine.
4. After a fallback CLI successfully completes the turn, promotes that CLI into the user's SQLite preference (`interactive_cli_preference` column in `bridge_state`) so the next message starts there instead of repeatedly retrying the exhausted CLI. If every CLI is exhausted, the stored preference is left unchanged.

### 4.6 Concurrency Lock & Message Queue

`db.tryLock(chatId)` is an atomic SQLite `UPDATE … WHERE active_execution_lock = 0` — only one execution per chat at a time. Lock is released in a `finally` block which also calls `drainQueue(chatKey)`.

If a chat is busy, the incoming message is queued to `pending_messages` in SQLite (max `MAX_QUEUE_DEPTH = 5`), surviving restarts. The user receives a position notice. When execution finishes, `drainQueue` pops the next item via `setImmediate` and calls `handleMessages` with a synthetic message. If the queue is full, the user receives "⏳ Queue is full."

### 4.7 Rate Limit Handling

`TelegramClient.call()` retries automatically on HTTP 429 up to 2 times, sleeping `retry_after` seconds between attempts.

### 4.8 MediaGroup Batching

Photos sent as an album share a `media_group_id`. `MediaGroupBuffer` collects messages for 1500ms, then flushes them as a single `handleMessages` call so the agent sees the full context.

---

## 5. CLI Integration Matrix

| Bot | Session flag | JSON output flag | Trusted flag |
|-----|-------------|-----------------|-------------|
| Codex | `exec resume <id>` | `--json` | `--dangerously-bypass-approvals-and-sandbox` |
| Antigravity | `--conversation <id>` | n/a (stdout parsed directly) | `--dangerously-skip-permissions` |
| Claude | `--resume <id>` | `--output-format stream-json` | `--dangerously-skip-permissions` |

### Timeout Configuration

| Setting | Default | Env variable |
|--------|---------|-------------|
| CLI hard timeout | 300s | `CLI_TIMEOUT_MS` |
| Idle timeout | 60s | `CLI_IDLE_TIMEOUT_MS` |
| Telegram fetch timeout | 45s | `FETCH_TIMEOUT_MS` |
| Poll interval | 1s | `POLL_INTERVAL_MS` |

---

## 6. Data Model

### BridgeConfig

```typescript
interface BridgeConfig {
  allowedUserIds: ReadonlySet<string>;
  serviceEnvFile: string | null;
  serviceKind: "codex" | "antigravity" | "claude" | null;
  pollIntervalMs: number;
  executionMode: "safe" | "trusted";
  cliTimeoutMs: number;
  asyncEnabled: boolean;
  dbPath: string;
  bots: {
    codex: BotConfig;
    antigravity: BotConfig;
    claude: BotConfig;
  };
}
```

### SQLite Schema

**`bridge_state`** — settings, sessions, locks:

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

**`conversation_turns`** — persistent per-chat message history:

```sql
CREATE TABLE conversation_turns (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_key TEXT NOT NULL,
  role    TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text    TEXT NOT NULL,
  cli     TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**`pending_messages`** — durable queue for messages that arrive while a lock is held:

```sql
CREATE TABLE pending_messages (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_key TEXT NOT NULL,
  prompt   TEXT NOT NULL,
  chat_id  INTEGER NOT NULL,
  thread_id INTEGER,
  chat_type TEXT,
  user_id  INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**`conversation_summaries`** — LLM-generated compact checkpoints written by `/compact`:

```sql
CREATE TABLE conversation_summaries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_key         TEXT NOT NULL,
  range_start_turn_id INTEGER NOT NULL,
  range_end_turn_id   INTEGER NOT NULL,
  summary_md       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

> Note: `conversation_turns` are pruned after `/compact` only after a final summary or tombstone is stored for the exact loaded range (rows up to `range_end_turn_id` deleted). Startup also performs the same summary-gated cleanup for any already-summarized turns left behind by an interrupted process. Unsummarized turns are never TTL-deleted. `conversation_summaries` are small and kept indefinitely.

---

## 7. File Structure

```
src/
├── index.ts            — Main entry, BridgeBot class, polling loop
├── cli.ts              — Process spawn, runCli/runCliAsync, abortCliProcess; injects AGENT_BRIDGE_* env
├── telegram.ts         — TelegramClient (HTTP), MediaGroupBuffer
├── messageDelivery.ts  — sendTelegramMessage, sendMessageWithProgress, StreamingUpdater
├── render.ts           — Text splitting, MarkdownV2, Telegram entities
├── bridge.ts           — Auth, session helpers, working dir resolution
├── db.ts               — BridgeDb (SQLite via better-sqlite3); conversation_turns/summaries/pending
├── types.ts            — TypeScript interfaces
├── commands.ts         — /reset, /models, /compact, /context (synchronous, returns string | null)
├── compactSummary.ts   — chunkCompactTurns, buildCompactSummaryPrompt, buildCompactReducePrompt, buildTombstone, compact constants
├── contextCommand.ts   — renderAgentBridgeContext: read-only DB helper for agent CLI access
├── timeouts.ts         — Timeout resolution (per-bot prefix → global → default)
└── agentMemory.ts      — agent-memory DB path resolution

bin/
└── agent-bridge-context  — Shell wrapper: invokes contextCommand.ts via tsx (read-only agent helper)

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
├── agent-bridge-antigravity.service
└── agent-bridge-claude.service

docs/
└── PRD.md            — This file
```

---

## 8. Security Model

### Authorization

`TELEGRAM_ALLOWED_USER_IDS` — comma-separated list of Telegram user IDs permitted to trigger executions. All other senders are silently ignored. The legacy single-value `TELEGRAM_ALLOWED_USER_ID` is accepted as a fallback.

### Execution Modes

| Mode | Codex flag | Antigravity flag | Claude flag |
|------|-----------|-----------------|-------------|
| `safe` | (none) | (none) | (none) |
| `trusted` | `--dangerously-bypass-approvals-and-sandbox` | `--yolo` | `--dangerously-skip-permissions` |

---

## 9. Deployment

### Systemd

Systemd units live in `systemd/`. Dedicated Telegram CLI bots share
`tsx src/index.ts`; the unified interactive bot uses `src/index-interactive.ts`;
the worker bot uses `src/index-worker.ts`; health uses `src/index-health.ts`;
Discord uses `src/index-discord.ts` and `src/index-discord-interactive.ts`.
Each service loads its own `/etc/default/agent-bridge-*` file and `NODE_BIN`
must point at Node 24+.

The installer (`scripts/install.sh`) requires Node 24+, generates local env
files from the `.env.*.example` templates, writes machine-specific values
(home dir, Node binary path, CLI binary paths, tokens) to service defaults, and
installs the standard services whose tokens/default files are present. Existing
deployments can be refreshed with `scripts/install-deployment.sh`, which also
requires Node 24+ and updates `NODE_BIN` in `/etc/default/agent-bridge-*`.

The interactive Telegram bot and worker bot are operator-enabled services:
create `/etc/default/agent-bridge-interactive` or
`/etc/default/agent-bridge-worker-bot` from their examples before enabling
those units.

### Database

Each service instance has its own `DB_PATH` to avoid SQLite lock contention.

```
.data-codex/bridge.sqlite
.data-antigravity/bridge.sqlite
.data-claude/bridge.sqlite
.data/interactive.sqlite
.data/worker.sqlite
.data/discord.sqlite
.data/discord-interactive.sqlite
```

WAL mode is enabled on open for concurrent read access.

Discord interactive sessions use one row per Discord channel/thread alias. The
runtime receives real Discord channel snowflakes, creates deterministic numeric
aliases for the shared engine, and rewrites outbound sends back to the original
snowflake. General channels, DMs, and Discord thread channels therefore remain
isolated from each other while sharing the same CLI backend code.

---

## 10. Error Handling

| Error | Handling |
|-------|----------|
| CLI hard timeout | Kill process, error edit on placeholder |
| CLI abort (`/stop`) | SIGKILL, resolve cleanly, bridge continues |
| CLI capacity exhausted | Retry with fallback model from `*_MODEL_PREFERENCE`, prepend warning |
| Telegram 429 | Auto-retry up to 2 times with `retry_after` delay |
| "Message is not modified" | No-op (not a real error) |
| Execution lock held | Reply "⏳ System is currently busy" |
| Parse error | Return raw stdout as text |
| Agy execution error | Scans `--log-file` for errors (e.g. `RESOURCE_EXHAUSTED`), throws JSON payload to trigger fallback, and de-duplicates colon-separated segments |

---

## 11. Known Limitations

- CLI sessions are provider thread IDs — bridge conversation history (turns/summaries) is separate and bridge-owned
- `conversation_turns` are pruned post-compact and at startup only when already covered by `conversation_summaries`; unsummarized history is retained
- Sync path (`BRIDGE_ASYNC_ENABLED=false`) available but not the default
- `abortCliProcess` SIGKILLs the top-level process only (not the full process group)
- Antigravity model switching is applied by mutating `~/.gemini/antigravity-cli/settings.json`; concurrent interactive Agy sessions (if any) would see the same setting
- Discord requires Message Content intent in the Developer Portal for plain-message routing
- Worker jobs depend on local git checkouts and GitHub token access; missing repos fail loudly instead of scanning or modifying the wrong path
- Discord snowflakes must go through the interactive adapter's alias mapping;
  direct `Number(snowflake)` conversion is unsafe for authorization and routing
