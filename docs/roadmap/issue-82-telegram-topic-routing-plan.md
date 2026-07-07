# Issue 82 — Telegram Topic Routing Fix Plan

Status: implementation plan
Issue: #82

## Summary

Telegram forum-topic updates already carry topic-aware routing state through `chatKey` and `message_thread_id` for most text replies. However, some outbound paths still send only the supergroup `chat_id`, which causes Telegram to post into General rather than the originating topic.

This plan fixes topic routing for generated output files and callback acknowledgement messages, and prevents output-directory collisions between concurrent topic runs in the same supergroup.

## Current Behaviour

### Correct paths

- Interactive companion messages resolve a topic-aware `chatKey` as `chatId:message_thread_id` for group and supergroup topics.
- Normal command replies and final execution text usually pass `message_thread_id` through `sendTelegramMessage`.
- CLI preferences, sessions, locks, fallback state, and conversation context are already scoped by `chatKey`.

### Broken paths

1. **Generated output file uploads**
   - `BridgeEngine` calls `uploadOutputFiles(outDir, chatId, client)` without a thread id.
   - `uploadOutputFiles` calls `sendPhoto(chatId, filePath)` or `sendDocument(chatId, filePath)`.
   - `TelegramClient.sendFile` only sends `chat_id`, file bytes, and optional caption in multipart form data.
   - Result: file uploads have no `message_thread_id` and can appear in General.

2. **Output directory isolation**
   - `prepareOutputDir(chatId, kind)` uses `/tmp/bridge-out/${kind}-${chatId}`.
   - Multiple topics in the same supergroup share the same `chatId`.
   - Result: concurrent runs from different topics can wipe or upload each other's generated files.

3. **Model/effort callback acknowledgements**
   - `BridgeEngine.handleCallback` reads `chatId` and `messageId`, but not `callbackQuery.message?.message_thread_id`.
   - It sends `Model set` and `Effort set` acknowledgement messages without topic metadata.
   - Result: those acknowledgement messages can appear in General.

## Design

### 1. Make file upload APIs topic-aware

Update the shared messaging interface so file delivery can carry transport-specific metadata without overfitting to Telegram.

Preferred minimal shape:

```ts
sendDocument(chatId: number, filePath: string, caption?: string, options?: { message_thread_id?: number }): Promise<void>;
sendPhoto(chatId: number, filePath: string, caption?: string, options?: { message_thread_id?: number }): Promise<void>;
```

Alternative acceptable shape:

```ts
sendDocument(body: { chat_id: number; filePath: string; caption?: string; message_thread_id?: number }): Promise<void>;
sendPhoto(body: { chat_id: number; filePath: string; caption?: string; message_thread_id?: number }): Promise<void>;
```

Prefer the minimal fourth-argument option to reduce churn.

### 2. Include `message_thread_id` in Telegram multipart uploads

Update `TelegramClient.sendFile(...)` to accept optional options and add all supported topic metadata to `FormData`:

```ts
if (options?.message_thread_id != null) {
  fd.set("message_thread_id", String(options.message_thread_id));
}
```

Then pass options through `sendDocument` and `sendPhoto`.

### 3. Pass `threadId` into output file upload

Update `uploadOutputFiles`:

```ts
uploadOutputFiles(outDir, chatId, client, { message_thread_id: threadId })
```

or equivalent.

All `BridgeEngine` upload sites must pass the current `threadId` / `body.message_thread_id`.

### 4. Key output directories by topic-aware `chatKey`

Change call sites from:

```ts
prepareOutputDir(chatId, this.kind)
```

to:

```ts
prepareOutputDir(chatKey, this.kind)
```

`prepareOutputDir` already accepts `number | string`, so this should be low-churn. It should sanitize path separators if needed, because topic keys contain `:` and future keys may contain other separators.

Suggested helper:

```ts
function safeOutputKey(value: number | string): string {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "_");
}
```

Use:

```ts
const dir = join(BRIDGE_OUT_BASE, `${kind}-${safeOutputKey(chatIdOrChatKey)}`);
```

### 5. Preserve topic metadata in callback acknowledgements

In `BridgeEngine.handleCallback`, capture:

```ts
const threadId = callbackQuery.message?.message_thread_id;
```

Then include it in all callback-generated messages:

```ts
await this.sendText(chatId, { text: `✓ Model set to ${value}`, message_thread_id: threadId });
await this.sendText(chatId, { text: `✓ Effort set to ${next}`, message_thread_id: threadId });
```

For `editMessageText`, keep the existing `chat_id` and `message_id`. Telegram edits target the existing message, so `message_thread_id` is not required there.

## Test Plan

Use TDD: add failing tests before implementation.

### `fileOutput.test.ts`

Add/extend tests for:

- `uploadOutputFiles` passes `message_thread_id` to `sendPhoto` for image files.
- `uploadOutputFiles` passes `message_thread_id` to `sendDocument` for non-image files.
- `prepareOutputDir` isolates topic-aware keys, for example `claude--100_10` and `claude--100_20`, or equivalent sanitized paths.
- `prepareOutputDir` no longer collides when the same supergroup has two topic keys.

### `telegram.test.ts`

Add tests for:

- `TelegramClient.sendDocument(..., { message_thread_id })` includes `message_thread_id` in multipart form data.
- `TelegramClient.sendPhoto(..., { message_thread_id })` includes `message_thread_id` in multipart form data.
- Calls without `message_thread_id` preserve current behaviour.

### `engine.test.ts`

Add tests for callback acknowledgements:

- model callback from a supergroup topic sends final acknowledgement with `message_thread_id`.
- effort callback from a supergroup topic sends final acknowledgement with `message_thread_id`.
- private-chat callback behaviour remains unchanged.

Add or update execution-path tests:

- generated output files from a topic execution are uploaded with the same `message_thread_id` as the originating message.

## Implementation Steps

1. Add failing tests for file output topic routing and output dir isolation.
2. Add failing tests for Telegram multipart topic metadata.
3. Add failing tests for model/effort callback acknowledgements.
4. Update `MessagingPlatform` file-send signatures.
5. Update `TelegramClient.sendFile`, `sendDocument`, and `sendPhoto`.
6. Update `uploadOutputFiles` to accept and forward topic metadata.
7. Update all `uploadOutputFiles` call sites in `BridgeEngine`.
8. Update `prepareOutputDir` call sites to use `chatKey` instead of `chatId`.
9. Update `BridgeEngine.handleCallback` acknowledgement messages to include `message_thread_id`.
10. Run full test suite and typecheck.

## Acceptance Criteria

- Files generated from topic A appear in topic A.
- Files generated from topic B appear in topic B.
- Concurrent file generation from two topics in the same supergroup uses isolated output directories.
- Model callback acknowledgement appears in the originating topic.
- Effort callback acknowledgement appears in the originating topic.
- Existing private chat and non-topic group behaviour is unchanged.
- Full test suite passes.
- Typecheck passes.

## Non-goals

- Do not change Telegram chat-key/session semantics.
- Do not change CLI/model selection scope.
- Do not redesign `sendTelegramMessage`.
- Do not add new commands.
- Do not change Discord transport behaviour except for compatible interface typing.
