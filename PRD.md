# Agent-Bridge PRD: Telegram CLI Bridge

## 1. Concept & Vision

**What it does:** Bridges Telegram messages to CLI-based AI coding agents (Codex, Gemini), enabling real-time conversational coding through a Telegram bot.

**Core experience:** A user sends a prompt via Telegram → the bridge spawns a CLI agent → the agent thinks/codes → responses stream back via Telegram editing.

**What makes it different:** It's a thin, reliable bridge—not an agent itself. It handles all the boring infrastructure (Telegram polling, rate limiting, message batching, session management, process lifecycle) so the CLI agent can focus on being smart.

---

## 2. Design Language

### Aesthetic
- **Minimal infrastructure, maximal transparency** — the bridge is invisible; the agent's output is everything
- **MarkdownV2 for Codex** — Telegram native formatting (bold, code, pre)
- **Native entities for Gemini** — avoids Markdown parsing issues
- **Progressive text editing** — real-time updates as the agent streams

### Architecture Patterns
- **File-based state** — sessions and settings stored as JSON files
- **Lock-based polling** — prevents duplicate polling across restarts
- **Outbox queue** — serializes messages per chat (rate limit protection)
- **MediaGroup buffering** — batches multi-image messages into one

---

## 3. System Architecture

```
┌─────────────────┐     ┌──────────────────────────────────────────┐
│   Telegram      │     │           Agent Bridge                    │
│   User ────────►│     │                                          │
│                 │◄────│  TelegramClient ◄── Polling               │
│                 │     │         │                                 │
│   ◄────────────│     │         ▼                                 │
│   Responses    │     │  BridgeBot                                │
│                 │     │    ├── handleUpdate()                     │
│                 │     │    ├── executePrompt() [sync]            │
│                 │     │    └── executePromptAsync() [streaming]   │
│                 │     │         │                                 │
│                 │     │         ▼                                 │
│                 │     │  runCli / runCliAsync                    │
│                 │     │    ├── spawn CLI process                  │
│                 │     │    ├── stream output via onProgress      │
│                 │     │    ├── parse result                       │
│                 │     │    └── kill on timeout                    │
│                 │     │         │                                 │
│                 │     │         ▼                                 │
│                 │     │  TelegramClient ◄── sendMessage/edit    │
│                 │     │                                          │
└─────────────────┘     └──────────────────────────────────────────┘
         │                            │
         ▼                            ▼
┌─────────────────┐         ┌─────────────────────────┐
│ Telegram API    │         │ CLI Backend             │
│ (api.telegram)  │         │ (codex / gemini)        │
└─────────────────┘         └─────────────────────────┘
```

---

## 4. Features & Flows

### 4.1 Message Processing Flow

```
Telegram Update
    │
    ▼
processTelegramUpdate()
    │
    ├── isAuthorizedMessage() ──► reject if not allowed user
    │
    ├── extractPromptText() ──► ignore if starts with "/"
    │
    ├── handleCommand() ──► /start, /reset, /models
    │                         │
    │                         └── Returns command response or null
    │
    ▼
executePrompt() OR executePromptAsync()
    │
    ├── buildCliInvocation() ──► builds CLI args
    │
    ├── sessionStore.get() ──► get persisted session ID
    │
    ├── runCli/runCliAsync()
    │   ├── spawn process
    │   ├── stream via onProgress (async path)
    │   ├── parse output
    │   └── kill on timeout
    │
    ├── sessionStore.set() ──► persist session ID
    │
    ▼
sendTelegramMessage() / sendMessageWithProgress()
    │
    ├── splitTelegramText() ──► chunk if > 3500 chars
    │
    ├── render formatting
    │   ├── Codex: MarkdownV2
    │   └── Gemini: native entities
    │
    └── outbox.send() ──► rate-limited serial queue
```

### 4.2 Session Persistence

| Bot | Mechanism | File |
|-----|-----------|------|
| Codex | `--thread <sessionId>` | JSON file per bot |
| Gemini | `--resume <sessionId>` | JSON file per bot |

Sessions are persisted across restarts. `/reset` clears the session.

### 4.3 Async vs Sync Path

| Aspect | Sync (`executePrompt`) | Async (`executePromptAsync`) |
|--------|------------------------|------------------------------|
| **Trigger** | Default (safe mode) | `BRIDGE_ASYNC_ENABLED=true` |
| **Output** | Single response | Stream via Telegram message editing |
| **Idle timeout** | Disabled | Disabled |
| **Typing indicator** | Yes (start only) | Yes (continuous) |

### 4.4 Rate Limiting

- **Telegram**: 30 msg/sec global, ~1 req/sec per chat
- **Outbox queue**: 1100ms minimum between sends per chat
- **429 handling**: `retryAfter` from response, exponential backoff

### 4.5 MediaGroup Batching

Telegram groups media (photos) into single updates. The bridge buffers them:

```
media_group_id batched
    │
    ▼
MediaGroupBuffer (1500ms flush)
    │
    └── onFlush() ──► single message with all photos
```

---

## 5. CLI Integration Matrix

| Bot | Session Flag | JSON Output | Trusted Flag |
|-----|------------|-------------|-------------|
| Codex | `--thread <id>` | `--json` | `--dangerously-bypass-approvals-and-sandbox` |
| Gemini | `--resume <id>` | `--output-format json` | `--approval-mode yolo` |

### Timeout Configuration

| Setting | Default | Env Variable |
|--------|---------|-------------|
| CLI hard timeout | 300s (5 min) | `CLI_TIMEOUT_MS` |
| Gemini fallback | 120s (2 min) | `GEMINI_FALLBACK_TIMEOUT_MS` |
| Idle timeout | **Disabled** | Typing indicator provides liveness |

---

## 6. Data Model

### BridgeConfig
```typescript
{
  allowedUserId: string;           // Telegram user ID (auth filter)
  serviceEnvFile: string;          // Path to .env.codex/.env.gemini
  serviceKind: "codex" | "gemini";
  pollIntervalMs: number;          // Polling frequency
  executionMode: "safe" | "trusted";
  cliTimeoutMs: number;
  geminiFallbackTimeoutMs: number;
  asyncEnabled: boolean;
  sessionStorePath: string;        // .data/sessions.json
  settingsStorePath: string;      // .data/settings.json
  bots: {
    codex: BotConfig;
    gemini: BotConfig;
  };
}
```

### Store Interface
```typescript
interface Store<T> {
  read(): Promise<T>;
  write(data: Partial<T>): Promise<void>;
}
```

### TelegramUpdate
```typescript
{
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}
```

---

## 7. File Structure

```
src/
├── index.ts          (452 lines) - Main entry, BridgeBot class
├── cli.ts            (440 lines) - Process spawn, runCli/runCliAsync
├── telegram.ts       (200 lines) - Telegram API client, polling
├── messageDelivery.ts (224 lines) - Sending, formatting, progress
├── render.ts        (155 lines) - Text splitting, Markdown
├── bridge.ts         (95 lines) - Helpers, auth, session
├── state.ts          (68 lines) - BridgeState persistence
├── store.ts          (79 lines) - JSON file store
├── types.ts         (112 lines) - TypeScript interfaces
├── outbox.ts         (41 lines) - Rate-limiting outbox queue
├── commands.ts       (41 lines) - /start, /reset, /models
└── updateLifecycle.ts (31 lines) - Update processing
```

---

## 8. Security Model

### Authorization
- `TELEGRAM_ALLOWED_USER_ID` — only this user can trigger prompts
- All other Telegram users receive "Unauthorized" rejection

### Execution Modes
| Mode | Behavior |
|------|----------|
| `safe` | Default, requires approvals for dangerous actions |
| `trusted` | Bypasses sandbox and approval requirements |

### Lock Files
- `.data/telegram-<kind>.lock` — prevents duplicate polling
- Stale lock cleanup on startup (PID check)

---

## 9. Deployment

### Systemd Services
```
/etc/systemd/system/agent-bridge-gemini.service
/etc/systemd/system/agent-bridge-codex.service
```

### Environment Files
```
.env.gemini  ─► TELEGRAM_BOT_TOKEN_GEMINI
              GEMINI_COMMAND / GEMINI_MODEL
              CLI_TIMEOUT_MS / BRIDGE_ASYNC_ENABLED

.env.codex   ─► TELEGRAM_BOT_TOKEN_CODEX
              CODEX_COMMAND / CODEX_MODEL
              CLI_TIMEOUT_MS
```

### Build
```bash
npm run build   # tsc → dist/
cp dist/*.js src/  # For systemd (uses src/index.js)
```

---

## 10. Error Handling

| Error Type | Handling |
|-----------|----------|
| CLI hard timeout | Kill process, return error message |
| CLI idle timeout | Kill process, return error (disabled) |
| Telegram 429 | Retry after `retryAfter` seconds |
| Telegram network timeout | Log, continue polling |
| Parse error | Log to stderr, return raw text fallback |
| Capacity exhausted | Log, return capacity message |

---

## 11. Known Limitations

1. **No multi-user support** — single `allowedUserId` only
2. **No conversation history** — each prompt is independent (sessions are thread IDs, not chat history)
3. **No slash-command UI** — commands are text-only (`/start`, `/reset`, `/models`)
4. **Sync path = default** — async must be explicitly enabled
5. **Gemini fallback** — separate invocation path when `--acp` mode fails

---

## 12. Future Considerations

- [ ] Multi-user support (allowlist per bot)
- [ ] Conversation history store (vector DB?)
- [ ] Webhook mode for production
- [ ] MiniMax CLI integration
- [ ] Qwen Code integration
- [ ] Admin panel for monitoring
- [ ] Slash command buttons inline
