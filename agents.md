# Agent Bridge — Architecture

The **Agent Bridge** connects Telegram and Discord directly to AI CLI backends (Codex, Antigravity, Claude Code) using chat transports, structured JSON parsing, per-chat execution locking, and a durable worker queue for background engineering jobs.

---

## System Overview

```
Telegram long-poll / Discord Gateway / worker timer
         │
         ▼
┌──────────────────────────────────────────────────────┐
│                 Agent Bridge services                │
│  • Dedicated Telegram CLI bots                       │
│  • Unified interactive Telegram bot (`/cli`)         │
│  • Telegram worker bot + durable SQLite job queue    │
│  • Discord single-CLI and interactive bots           │
│  • Health scheduler and report bot                   │
└──────────────────┬───────────────────────────────────┘
                   │
      ┌────────────┼────────────┐
      │            │            │
 Antigravity       Codex        Claude Code
 (agy CLI)         (codex CLI)  (claude CLI)
```

Each runtime surface is an **independent systemd service** sharing the same TypeScript source. Services load shared defaults where configured, then their service-specific environment:

| Service | Shared env | Bot-specific env | Data Dir |
|---------|-----------|-----------------|----------|
| `agent-bridge-antigravity.service` | `.env.shared` | `/etc/default/agent-bridge-antigravity` | `.data-antigravity/` |
| `agent-bridge-codex.service` | `.env.shared` | `/etc/default/agent-bridge-codex` | `.data-codex/` |
| `agent-bridge-claude.service` | `.env.shared` | `/etc/default/agent-bridge-claude` | `.data-claude/` |
| `agent-bridge-interactive.service` | `.env.shared` | `/etc/default/agent-bridge-interactive` | `.data/interactive.sqlite` |
| `agent-bridge-worker-bot.service` | `.env.shared` | `/etc/default/agent-bridge-worker-bot` | `.data/worker.sqlite` |
| `agent-bridge-health.service` | `.env.shared` | `/etc/default/agent-bridge-health` | service DB / monitored DBs |
| `agent-bridge-discord-interactive.service` | `.env.shared` | `/etc/default/agent-bridge-discord-interactive` | `.data/discord-interactive.sqlite` |

Shared env holds settings that apply to all services: allowed user IDs, execution mode, bridge paths, health monitoring config, and shared memory paths. Service-specific files hold tokens, CLI command/model preferences, platform credentials, DB path, and worker feature flags. See `.env.shared.example` and `.env.*.example` for the full reference.

### Discord Session Mapping

Discord channel snowflakes are the isolation boundary. Server channels, DM
channels, and thread channels each carry their own `channel_id`; the interactive
Discord service treats that ID as the user-facing conversation key.

The shared `BridgeEngine` still expects Telegram-shaped numeric IDs. The
Discord interactive adapter therefore:

- converts Discord channel and author snowflakes into deterministic numeric
  aliases before calling the engine
- stores CLI sessions under those stable aliases in the Discord service DB
- keeps CLI preference and fallback context keyed by the original channel
  snowflake
- maps outbound engine sends back to the original Discord channel snowflake
  before calling Discord REST

Do not bypass this adapter or pass lossy `Number(snowflake)` values directly
into the engine. That breaks authorization, session isolation, and reply
routing for large Discord IDs.

## Sandbox Workspaces

Use the `git-sandbox` skill to isolate substantial or complex changes. For large-scale refactoring or multi-commit implementations, create a git worktree sandbox rather than developing directly inside active, running process directories.

## Path Portability Rule
All future path-related changes must be machine agnostic. Prefer explicit environment variables first, then repo-relative or process-cwd defaults. Do not hardcode user names, home directories, deployment host paths, or local workspace layouts into source, tests, docs, or generated service defaults. Examples should use placeholders such as `/path/to/agent-bridge` unless they are describing an actual required Linux convention like `/etc/default`.

## Shared Memory

Agent Bridge uses bridge-owned project memory in SQLite. Spawned agents receive
`AGENT_BRIDGE_CONTEXT_COMMAND` when memory is available.

Use:

```bash
"$AGENT_BRIDGE_CONTEXT_COMMAND" --memory-query "<short query>"
"$AGENT_BRIDGE_CONTEXT_COMMAND" --memory-add-json '<json>'
```

Do not save secrets, passwords, transient logs, or private data.

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
| `effort:antigravity` / `effort:codex` / `effort:claude` (in `settings`) | Active effort override set via `/effort` |

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
| **Codex** | `exec [resume <sessionId>]`, `-c model_reasoning_effort="<level>"`, `--skip-git-repo-check`, `--model <m>`, `--json`, `--dangerously-bypass-approvals-and-sandbox` (trusted) |
| **Antigravity** | `--conversation <sessionId>` for resumes, `--dangerously-skip-permissions` (trusted), `--log-file <path>`, `--print <prompt>` |
| **Claude** | `--effort <level>`, `--print`, `--model <m>`, `--resume <sessionId>`, `--dangerously-skip-permissions` (trusted), `--output-format json` |

Session handling differs per bot:
- **Codex / Claude** — pass `sessionId` directly; new sessions receive no session arg (the CLI creates one)
- **Antigravity** — new sessions receive no conversation arg; existing sessions use `--conversation <uuid>`. Agy requires all flags before `--print <prompt>` because `--print` consumes the prompt as its value. Agy does not accept a `--model` CLI flag; instead, model selection is applied by mapping the chosen model ID to its display label (e.g. `gemini-3.5-flash-high` to `Gemini 3.5 Flash (High)`) and writing it to `~/.gemini/antigravity-cli/settings.json` before execution.
- **Effort** — valid levels are `low`, `medium`, `high`, `xhigh`, `max`; default `medium`. Codex maps effort to `model_reasoning_effort`, Claude maps it to `--effort`, and Agy is an explicit unsupported/no-op because its CLI has no separate effort flag.

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
         msg.includes("Overloaded") ||
         msg.includes("RESOURCE_EXHAUSTED") ||
         msg.includes("quota reached") ||
         msg.includes("quota exceeded") ||
         msg.includes("hit your limit") ||
         msg.includes("session limit") ||
         msg.includes("usage limit") ||
         msg.includes("resets") ||
         msg.includes("api_error_status\":429");
}
```

When triggered, model fallback picks the next entry in the model preference list. If all model options of the active CLI are exhausted, the bridge initiates a CLI-to-CLI fallback:
- **Worker Bot**: Advances the worker fallback chain (`codex` → `claude` → `antigravity`) and retries the execution with a context preamble.
- **Interactive Bot**: Advances the interactive fallback chain, updates the user's SQLite preference (`interactive_cli_preference`), notifies the user, and retries the execution with a context preamble (last 3 turns).

---

## Model Preference

Configured via `*_MODEL_PREFERENCE` env var (comma-delimited):

```
ANTIGRAVITY_MODEL_PREFERENCE=gemini-3.5-flash-high,gemini-3.5-flash-medium,gemini-3.1-pro-high,gemini-3.1-pro-low  # mapped to display labels for settings.json overrides
CODEX_MODEL_PREFERENCE=gpt-5.6-luna,gpt-5.6-sol,gpt-5.6-terra,gpt-5.5,gpt-5.4,gpt-5.4-mini
CLAUDE_MODEL_PREFERENCE=claude-sonnet-4-6,claude-opus-4-8,claude-fable-5
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

Callback data format: `model:<kind>:<value>` / `model:<kind>:reset` and `effort:<kind>:<level>` / `effort:<kind>:reset`

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

---

## File Exchange (Inbound + Outbound)

Two-way file exchange is fully wired. Users can send photos or documents to any bot; the bot downloads them, passes them to the CLI, and if the CLI generates output files they are automatically sent back.

### Inbound (Telegram → CLI)

| Bot | Mechanism |
|-----|-----------|
| **Antigravity** | File path injected as `[Attached file saved at: /tmp/bridge-uploads-<chatId>/<file>]` annotation appended to prompt text |
| **Codex** | `-i <file>` flag per attachment on new sessions; attachments silently dropped on resume (Codex `-i` is new-session only) |
| **Claude** | `--input-format stream-json --output-format stream-json --verbose` with base64 image payload piped to stdin |

- Attachment is downloaded to `/tmp/bridge-uploads-<chatId>/` before CLI invocation via `TelegramClient.getFilePath()` + `downloadFile()`
- Maximum attachment size: **20 MB** (Telegram bot API limit) — oversized files are silently skipped
- Attachment file is deleted after CLI execution regardless of outcome

### Outbound (CLI → Telegram)

- Before every CLI invocation, `prepareOutputDir(chatId)` creates `/tmp/bridge-out/<chatId>/`
- The instruction `If you generate any files, save them to /tmp/bridge-out/<chatId>` is appended to every prompt for all bots
- After execution, `uploadOutputFiles()` scans the directory, sends `.png`/`.jpg`/`.gif`/`.webp` as `sendPhoto` and everything else as `sendDocument`, then deletes each file and removes the directory

### Key new source files

| File | Purpose |
|------|---------|
| `src/fileDownload.ts` | `downloadTelegramAttachment()`, `mimeTypeFromExtension()` |
| `src/fileOutput.ts` | `prepareOutputDir()`, `collectOutputFiles()`, `uploadOutputFiles()`, `cleanOutputDir()` |
| `src/claudeStreamJson.ts` | `buildClaudeStreamJsonInput()`, `parseClaudeStreamJsonOutput()`, `encodeFileAsBase64()` |

---

## Autonomous Worker Lane

Alongside the interactive bots, `agent-bridge-worker-bot.service` runs
`src/index-worker.ts`: a separate Telegram bot plus a background job executor
over a durable SQLite queue (`work_items`, `work_jobs`, `approvals`,
`github_links`).

```text
Telegram command → work item / job row → executor loop (10s poll)
   → handler (defect_scan | feature_plan | tdd_implementation |
              open_github_issue | pr_lifecycle | pr_watch | pr_refresh)
   → Telegram notification (+ merge keyboard when a PR opens)
```

Key mechanics:

- **Claim/lease lifecycle** — `claimNextWorkJob` takes a lease (300s standard,
  1800s for `feature_plan`/`tdd_implementation`); the executor heartbeats the
  lease while a handler runs so long jobs are never reclaimed mid-flight.
  Loop ticks are serialized (one job in flight per process). Unhandled task
  types fail permanently instead of blocking the queue head.
- **Per-job workspaces** (`src/workspace.ts`) — implementation jobs clone the
  local checkout under `$WORKER_REPO_ROOT` into
  `$WORKER_WORKSPACE_DIR/work-<id>`, repoint `origin` at the real remote, and
  never touch live checkouts. Failed jobs delete their workspace; the
  `pr_lifecycle` handler deletes it after the branch is pushed and the draft
  PR exists.
- **TDD enforcement** (`src/handlers/tddImplementation.ts`) — red commit may
  stage test files only; the red run must fail before tests are committed;
  green commit may not touch test files; verification must pass before the
  implementation commit.
- **Merge gate** (`src/prMergeGate.ts`) — the `merge_pr` approval payload pins
  the branch head SHA. The Merge button runs `gh pr view` and blocks when the
  head moved, checks are failing/incomplete, or PR state cannot be verified.
  Approval stays pending on every blocked path; all callbacks are answered.
- **Async exec** (`src/runCommandAsync.ts`) — all git/gh/npm children run via
  `execFile`, keeping Telegram polling responsive; `GH_TOKEN` is loaded from
  `$GITHUB_TOKEN_FILE` for gh API calls.
- **Cancellation** — `cancelWorkJob` is final: complete/fail cannot overwrite
  a cancelled status.

Operator docs: `docs/WORKER-GUIDE.md`. Design and phase plan:
`docs/autonomous-agent-bridge-research.md`.

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
│   ├── fileDownload.ts    — downloadTelegramAttachment(), mimeTypeFromExtension()
│   ├── fileOutput.ts      — prepareOutputDir(), uploadOutputFiles(), cleanOutputDir()
│   ├── claudeStreamJson.ts — buildClaudeStreamJsonInput(), parseClaudeStreamJsonOutput()
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
│           ├── server.ts  — ServerPlugin: CPU load, memory, swap, zombie, and systemd/perm checks
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
│   └── upgrade.sh — Update existing deployment (npm, CLI update, service reload)
├── .env.shared            — Live shared config for all bots (gitignored)
├── .env.shared.example    — Shared config template (committed)
├── .env.antigravity       — Live Antigravity config (gitignored)
├── .env.codex             — Live Codex config (gitignored)
├── .env.claude            — Live Claude config (gitignored)
├── .env.*.example         — Bot-specific config templates (committed)
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
| `CODEX_EFFORT` / `ANTIGRAVITY_EFFORT` / `CLAUDE_EFFORT` | Each | Effort default (`medium`). Agy value is stored/displayed only; no CLI effort flag exists |
| `CODEX_PROJECT_DIR` / `ANTIGRAVITY_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` | Each | Override CLI working directory for this bot |
| `BRIDGE_EXECUTION_MODE` | All | `safe` (approval prompts) / `trusted` (bypass) |
| `BRIDGE_ASYNC_ENABLED` | All | `true` = streaming, `false` = sync (default: `true`) |
| `CLI_TIMEOUT_MS` | All | Hard timeout per CLI execution (default: 1 800 000ms for Codex; 600 000ms for others) |
| `CLI_IDLE_TIMEOUT_MS` | All | Kill CLI after this many ms with no stdout output (default: 240 000ms Codex; 480 000ms Antigravity; 180 000ms Claude) |

`GEMINI_*` env names are deprecated compatibility aliases for Antigravity/Agy
only. Keep them working for existing VPS defaults, but use `ANTIGRAVITY_*` for
new config because Agy has replaced the older Gemini CLI naming.
| `FETCH_TIMEOUT_MS` | All | Telegram API fetch timeout (default: 45 000ms) |
| `DB_PATH` | Each | Path to SQLite database (default: `<project-dir>/.data/bridge.sqlite`) |
| `BRIDGE_PROJECT_DIR` | All | Repo path (used for default `DB_PATH`) |
| `AGENT_BRIDGE_SOUL_PATH` | All | Optional persona contract path (default: `<project-dir>/SOUL.md`) |
| `AGENT_BRIDGE_SOUL_MODE` | All | `summary`, `full`, or `off` (default: `summary`) |
| `TELEGRAM_DOCUMENT_FALLBACK_ENABLED` | Telegram bots | `true` opts in to in-memory `response.md` attachments for exceptional oversized/code-heavy final responses (default: off) |
| `TELEGRAM_LAYOUT_DOCUMENT_THRESHOLD` | Telegram bots | Attachment threshold used only when `TELEGRAM_DOCUMENT_FALLBACK_ENABLED=true` (default: 3500) |
| `TELEGRAM_LAYOUT_CODE_BLOCK_THRESHOLD` | Telegram bots | Code-block attachment threshold used only when `TELEGRAM_DOCUMENT_FALLBACK_ENABLED=true` (default: 3) |
| `HEALTH_MONITOR_ENABLED` | All | `false` to disable health monitoring. **Currently disabled by default in `.env.shared`** — see `docs/health-monitor-rectification.md` before re-enabling. |
| `HEALTH_MONITOR_CADENCE_SECONDS` | All | Seconds between health check runs (default: `3600`) |
| `HEALTH_MONITOR_AUTONOMY` | All | `report` — report only; `suggest` — also spawns a CLI for diagnosis (default: `report`) |
| `HEALTH_MONITOR_CHAT_ID` | All | Telegram chat ID for health reports; if unset, logs to stdout |
| `HEALTH_SUGGEST_BOT` | All | CLI to use for suggest mode: `codex`, `antigravity`, `claude` (default: `claude`) |
| `HEALTH_SERVER_MONITOR_ENABLED` | All | `1` to enable the built-in server resource monitor plugin (default: `1`) |
| `HEALTH_CPU_LOAD_AMBER_MULTIPLIER` | All | Threshold multiplier for CPU load warning (default: `1.0`) |
| `HEALTH_CPU_LOAD_RED_MULTIPLIER` | All | Threshold multiplier for CPU load critical (default: `1.5`) |
| `HEALTH_CPU_LOAD_AMBER_THRESHOLD` | All | Override for absolute CPU load warning threshold |
| `HEALTH_CPU_LOAD_RED_THRESHOLD` | All | Override for absolute CPU load critical threshold |
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

**`ServerPlugin`** — always registered. Checks CPU load, RAM/Swap usage, zombie processes, system uptime, and security posture (UFW status, SSH private key permissions, and project directory `.env` file permissions).

**`ExternalPlugin`** — wraps any shell command. Spawns the command asynchronously with a timeout, expects exit 0 and a `HealthReport` JSON on stdout. Returns a synthetic red report on failure or invalid JSON.

### Current status

Health monitoring is **disabled** (`HEALTH_MONITOR_ENABLED=false` in `.env.shared`). There are known bugs that must be fixed before re-enabling — see `docs/health-monitor-rectification.md` for the full list and re-enable checklist. The two blocking issues are: `ExternalPlugin` uses `spawnSync` which blocks the event loop for up to 30s, and `generateSuggestion` can forward agy's internal error string verbatim to the user.

### Suggest mode

When `HEALTH_MONITOR_AUTONOMY=suggest` and a report returns amber or red, `runPlugin()` calls `generateSuggestion()` and sends the result as a follow-up Telegram message.

`generateSuggestion` routes through `buildCliInvocation → runCli → parseCliResult` — **the same execution path used for real user messages**. Auth, permissions flags, model selection, and output parsing are all handled identically. The bot used is configured by `HEALTH_SUGGEST_BOT` (default: `claude`).

```typescript
// src/health/scheduler.ts — dependency-injectable for testing
constructor(options: {
  ...
  _suggestFn?: SuggestFn;  // inject a mock in tests; defaults to generateSuggestion
})
```

The prompt sent to the CLI includes only non-green failing checks with their messages. The CLI's full response is forwarded to Telegram as-is.

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

No lock files to clear. The SQLite polling offset persists across restarts — no re-processing of old updates.

#### From an external terminal

```bash
sudo systemctl restart agent-bridge-antigravity
sudo systemctl restart agent-bridge-codex
sudo systemctl restart agent-bridge-claude
```

#### From within an active bot session (safe restart)

Restarts from within a session are permitted only through the narrow safe
restart helper. Systemd uses `KillMode=control-group`, so a direct
`systemctl restart` would kill the bridge process before it can deliver its
final Telegram message to the user. The helper avoids this with a 5-second
delay and a fixed unit list:

1. **Notify the user first** — include the restart warning in your response text (e.g. *"Restarting bridge in 5 seconds — reconnect to continue."*).
2. **Run the helper**:

```bash
sudo -n /usr/local/sbin/restart-agent-bridge
```

Install `scripts/restart-agent-bridge.sh` as root-owned
`/usr/local/sbin/restart-agent-bridge`, then grant only that exact command via
sudoers. Do not grant `NOPASSWD: ALL` or raw passwordless `systemctl`.

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
