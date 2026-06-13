# Discord Compatibility Research & Implementation Plan

## Status

**Planned.** No implementation started. This document covers the API delta, proposed architecture, and a phased build sequence.

## Executive Summary

The bridge is today Telegram-native: polling, message editing, session keys, and typing indicators all couple tightly to Telegram's HTTP API. Adding Discord is achievable without rewriting the core, but it requires a platform abstraction layer in front of `BridgeEngine` and a WebSocket-based transport to replace `TelegramClient`.

The lowest-risk path is a thin **adapter interface** that both `TelegramClient` and a new `DiscordClient` satisfy, with a separate Discord entry point (`src/index-discord.ts`) that wires the adapter into the existing engine. The engine itself (`engine.ts`) would be updated to call the adapter rather than a Telegram-specific client.

---

## Platform Comparison

| Capability | Telegram | Discord |
|---|---|---|
| Transport | HTTP long-poll (`getUpdates`) | WebSocket Gateway (`wss://gateway.discord.gg`) |
| Update format | `TelegramUpdate` JSON objects | Gateway event payloads (`MESSAGE_CREATE`, etc.) |
| Send message | `sendMessage` → returns message_id | POST `/channels/{id}/messages` → returns message object |
| Edit message | `editMessageText` (by message_id) | PATCH `/channels/{id}/messages/{id}` |
| Typing indicator | `sendChatAction` | POST `/channels/{id}/typing` |
| Command registration | BotFather `/setcommands` | REST `PUT /applications/{id}/commands` |
| Slash commands | `/command` as plain text | Interactions API (Webhook or Gateway event `INTERACTION_CREATE`) |
| Threads | `message_thread_id` on messages | Thread channels (child of a parent channel) |
| Auth | `Bot <token>` header | `Bot <token>` header (same shape) |
| Message length | 4096 chars | 2000 chars |
| Rate limits | Per-chat, generous | Per-route, stricter (50 req/s global) |
| File delivery | `sendDocument` / `sendPhoto` | Multipart POST with `files[]` |
| Inline keyboards | `reply_markup` | Components API (buttons, select menus) |

---

## API Integration Points

### 1. Transport — WebSocket Gateway

Discord requires a WebSocket connection to receive events, not HTTP polling. The connection lifecycle:

```
Connect → wss://gateway.discord.gg/?v=10&encoding=json
← Opcode 10 Hello { heartbeat_interval }
→ Opcode 2 Identify { token, intents }
← Opcode 0 Ready
← Opcode 0 MESSAGE_CREATE (ongoing)
→ Opcode 1 Heartbeat (every heartbeat_interval ms)
```

**Intents required:** `GUILDS` (1) + `GUILD_MESSAGES` (512) + `MESSAGE_CONTENT` (32768) — the last must be enabled in the Discord Developer Portal (Privileged Intent). For DMs: `DIRECT_MESSAGES` (4096).

### 2. Message Chunking

Discord's 2000-char limit vs Telegram's 4096 means CLI output will need splitting more often. The existing `sendMessageWithProgress` streaming already chunks; the chunk size constant needs to drop to ≤1990 chars for Discord.

### 3. Slash Commands

Discord slash commands are registered via REST before they appear in the client. Unlike BotFather's `setMyCommands` (instant), Discord's command registration can take up to an hour to propagate globally; guild-scoped commands propagate immediately.

Registration endpoint: `PUT /applications/{application_id}/commands`

The `buildTelegramCommands` output shape (`{command, description}`) maps cleanly to Discord's `{name, description, type: 1}`.

### 4. Interactions

When a user invokes a slash command on Discord, the bot receives an `INTERACTION_CREATE` event (not a `MESSAGE_CREATE`). The bot must respond within **3 seconds** via the interactions endpoint or the command shows as failed. For long-running CLI operations, this means:

1. ACK immediately with `type: 5` (deferred channel message)
2. Follow up with `PATCH /webhooks/{application_id}/{interaction_token}/messages/@original` once the CLI completes

This maps to the existing "send placeholder, edit with result" pattern.

### 5. Session Keys

Current session keys are `chatId` or `chatId:threadId`. Discord equivalent:
- DM: `channelId` (each DM is a dedicated channel)
- Server channel: `channelId`
- Thread: `threadId` (thread channels have their own ID)

The key format can stay as a string — Discord channel IDs are snowflakes (numeric strings) which do not collide with Telegram's integer chat IDs as long as databases are kept separate.

---

## Proposed Architecture

### Adapter Interface

```ts
// src/platform.ts
export interface MessagingPlatform {
  sendMessage(channelId: string, body: SendMessageBody): Promise<{ messageId: string }>;
  editMessage(channelId: string, messageId: string, text: string): Promise<void>;
  sendTyping(channelId: string): Promise<void>;
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  uploadFile(channelId: string, filename: string, data: Buffer): Promise<void>;
  setCommands(commands: BotCommand[], scope?: CommandScope): Promise<void>;
}
```

`TelegramClient` implements this interface. `DiscordClient` (new) also implements it. `BridgeEngine` accepts a `MessagingPlatform` instead of hard-coding `TelegramClient`.

### New Files

| File | Purpose |
|---|---|
| `src/platform.ts` | `MessagingPlatform` interface + shared types |
| `src/discord.ts` | `DiscordClient` — WebSocket gateway + REST API wrapper |
| `src/discord-gateway.ts` | Raw WebSocket heartbeat/reconnect/resume logic |
| `src/index-discord.ts` | Discord entry point (mirrors `index.ts`) |
| `.env.discord.example` | Example env for Discord bot |
| `systemd/agent-bridge-discord.service` | Service unit |

### Modified Files

| File | Change |
|---|---|
| `src/telegram.ts` | Implement `MessagingPlatform` |
| `src/engine.ts` | Accept `MessagingPlatform` instead of `TelegramClient` |
| `src/messageDelivery.ts` | Chunk at 1990 chars when platform is Discord |
| `src/types.ts` | Add `platform: "telegram" \| "discord"` to engine options |

---

## Implementation Phases

### Phase 1 — Platform abstraction (no new features, tests must stay green)

1. Define `MessagingPlatform` interface in `src/platform.ts`.
2. Add `implements MessagingPlatform` to `TelegramClient`. Fix any mismatches.
3. Update `BridgeEngine` constructor to accept `MessagingPlatform`.
4. Update `messageDelivery.ts` to call interface methods.
5. All 857 existing tests must pass unchanged.

### Phase 2 — Discord Gateway client

1. Implement `DiscordGateway` in `src/discord-gateway.ts`:
   - Connect, identify, heartbeat loop, reconnect on disconnect, resume on resume codes.
   - Emit typed events: `MESSAGE_CREATE`, `INTERACTION_CREATE`.
2. Implement `DiscordClient` in `src/discord.ts`:
   - REST helpers: send, edit, delete, typing, file upload, command registration.
   - Wraps `DiscordGateway` for event reception.
   - Implements `MessagingPlatform`.
3. Unit tests covering: heartbeat, reconnect, message chunking at 1990 chars.

### Phase 3 — Discord entry point

1. `src/index-discord.ts`: mirrors `index.ts`, loads `.env.discord`, creates `DiscordClient`, wires into `BridgeEngine`.
2. `systemd/agent-bridge-discord.service` unit file.
3. `.env.discord.example` with: `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID` (optional, for instant command registration), `TELEGRAM_ALLOWED_USER_IDS` → `DISCORD_ALLOWED_USER_IDS`.
4. Register slash commands on startup.
5. End-to-end smoke test: send a message → CLI runs → response arrives in Discord.

### Phase 4 — Interactions (slash command flow)

1. Handle `INTERACTION_CREATE` in `DiscordClient` event loop.
2. ACK within 3 seconds with deferred response.
3. Follow up with CLI result via `PATCH /webhooks/…/@original`.
4. Wire `/reset`, `/models`, `/stop`, `/cancel` as slash commands.

### Phase 5 — Interactive Discord bot (optional)

Mirror the `index-interactive.ts` multi-CLI routing for Discord: a single Discord bot that routes to codex/claude/antigravity based on per-channel preference, stored in a separate SQLite database.

---

## Environment Variables

```bash
DISCORD_BOT_TOKEN=          # Bot token from Discord Developer Portal
DISCORD_APPLICATION_ID=     # Application ID (not the bot user ID)
DISCORD_GUILD_ID=           # Optional: restrict command registration to one guild (instant)
DISCORD_ALLOWED_USER_IDS=   # Comma-separated Discord user snowflake IDs
DISCORD_CLI_TIMEOUT_MS=1800000
DISCORD_CLI_IDLE_TIMEOUT_MS=1200000
DB_PATH=.data-discord/bridge.sqlite
```

---

## Key Risks

| Risk | Mitigation |
|---|---|
| `MESSAGE_CONTENT` privileged intent must be enabled manually in Discord Developer Portal | Document in README; fail fast with a clear error at startup if not granted |
| 3-second interaction ACK window | Always ACK immediately with deferred response; never await CLI before ACKing |
| Discord rate limits (50 req/s global, 5 req/s per channel) | Add per-channel rate limit tracking in `DiscordClient`; queue edits |
| Reconnect storms on gateway disconnect | Exponential backoff + jitter; honour Discord's `RECONNECT` and `INVALID_SESSION` opcodes |
| 2000-char message limit | Enforce in `messageDelivery.ts` at the platform level; caller should not need to know |

---

## Implementation Order Recommendation

Start with Phase 1 (abstraction). It has zero user-visible impact and makes all subsequent phases straightforward. The riskiest part is the gateway WebSocket lifecycle (Phase 2); isolate it in `discord-gateway.ts` so it can be unit-tested independently of the REST API.

Total estimated scope: ~600–800 lines of new code across 4–5 files, plus ~100 lines of modification to existing files.
