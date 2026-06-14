# Discord Compatibility Research & Implementation Plan

## Status

**Implemented baseline.** Discord now has Gateway-based single-CLI and
interactive entry points:

- `src/discord-gateway.ts`
- `src/discord.ts`
- `src/index-discord.ts`
- `src/index-discord-interactive.ts`
- `.env.discord.example`
- `.env.discord-interactive.example`
- `systemd/agent-bridge-discord.service`
- `systemd/agent-bridge-discord-interactive.service`

This document is retained as the compatibility map, implementation record, and
follow-up checklist.

## Executive Summary

The bridge now supports Discord without replacing the Telegram path. Discord is
implemented as separate entry points and a Gateway/REST client that converts
Discord events into the bridge's existing engine shape where practical.

The main remaining work is operational hardening: live rate-limit telemetry,
clear startup failures for missing privileged intents, and broader end-to-end
smoke coverage against a real guild.

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

Current Telegram session keys are `chatId` or `chatId:threadId`. Discord
equivalent:

- DM: `channelId` (each DM is a dedicated channel)
- Server channel: `channelId`
- Thread: `thread channelId` (Discord threads are channels with their own ID)

The implemented interactive Discord path keeps the Discord channel snowflake as
the top-level conversation key for preferences and fallback context. When it
passes a message into the shared Telegram-shaped `BridgeEngine`, it converts the
channel and author snowflakes into deterministic numeric aliases, stores CLI
session state under those aliases, and maps outbound sends back to the original
Discord channel snowflake before calling the Discord REST API. This keeps
general channels, DMs, and thread channels isolated without forking the engine.

---

## Implemented Architecture

### Adapter Shape

`DiscordClient` exposes the message, edit, typing, file, and command
registration operations needed by the Discord entry points. The dedicated
Discord bot maps gateway updates into Telegram-like bridge updates before
calling `BridgeEngine`; the interactive Discord bot mirrors the Telegram
interactive router with Discord interactions and buttons, plus a snowflake alias
adapter for channel/thread isolation.

### Implemented Files

| File | Purpose |
|---|---|
| `src/discord.ts` | `DiscordClient` — WebSocket gateway + REST API wrapper |
| `src/discord-gateway.ts` | Raw WebSocket heartbeat/reconnect/resume logic |
| `src/index-discord.ts` | Discord entry point (mirrors `index.ts`) |
| `src/index-discord-interactive.ts` | Interactive Discord entry point with CLI switching |
| `.env.discord.example` | Example env for Discord bot |
| `.env.discord-interactive.example` | Example env for interactive Discord bot |
| `systemd/agent-bridge-discord.service` | Service unit |
| `systemd/agent-bridge-discord-interactive.service` | Interactive service unit |

---

## Implementation Phases

### Phase 1 — Platform abstraction

Status: superseded by a lighter adapter path. Telegram remains unchanged;
Discord entry points adapt incoming events and outgoing delivery around the
existing engine contracts.

### Phase 2 — Discord Gateway client

Status: implemented.

1. Implement `DiscordGateway` in `src/discord-gateway.ts`:
   - Connect, identify, heartbeat loop, reconnect on disconnect, resume on resume codes.
   - Emit typed events: `MESSAGE_CREATE`, `INTERACTION_CREATE`.
2. Implement `DiscordClient` in `src/discord.ts`:
   - REST helpers: send, edit, delete, typing, file upload, command registration.
   - Wraps `DiscordGateway` for event reception.
   - Implements `MessagingPlatform`.
3. Unit tests covering: heartbeat, reconnect, message chunking at 1990 chars.

### Phase 3 — Discord entry point

Status: implemented.

1. `src/index-discord.ts`: mirrors `index.ts`, loads `.env.discord`, creates `DiscordClient`, wires into `BridgeEngine`.
2. `systemd/agent-bridge-discord.service` unit file.
3. `.env.discord.example` with: `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID` (optional, for instant command registration), `TELEGRAM_ALLOWED_USER_IDS` → `DISCORD_ALLOWED_USER_IDS`.
4. Register slash commands on startup.
5. End-to-end smoke test: send a message → CLI runs → response arrives in Discord.

### Phase 4 — Interactions (slash command flow)

Status: implemented for command ACK and follow-up flow used by the Discord
entry points.

1. Handle `INTERACTION_CREATE` in `DiscordClient` event loop.
2. ACK within 3 seconds with deferred response.
3. Follow up with CLI result via `PATCH /webhooks/…/@original`.
4. Wire `/reset`, `/models`, `/stop`, `/cancel` as slash commands.

### Phase 5 — Interactive Discord bot

Status: implemented in `src/index-discord-interactive.ts`.

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
| Reconnect storms on gateway disconnect | Terminal close codes stop reconnecting; pre-READY closes are capped; normal reconnects still use exponential backoff + jitter |
| 2000-char message limit | Enforce in `messageDelivery.ts` at the platform level; caller should not need to know |

---

## Remaining Work

- Fail fast when Discord Message Content intent is missing.
- Add rate-limit counters and log summaries for REST send/edit routes.
- Add an operator smoke-test checklist for guild-scoped command registration,
  DM delivery, channel delivery, thread delivery, and interactive buttons.
