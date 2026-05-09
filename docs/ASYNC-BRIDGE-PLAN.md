# Agent Bridge Async Execution Plan

## Context

### What exists today
- **sync execution**: `executePrompt()` in `src/index.js` runs `runCli()` blocking
- **response flow**: receive → run → parse → reply (user waits 60-180s)
- **timeout handling**: CLI idle/hard timeout kills process, falls back to read-only
- **message delivery**: `src/messageDelivery.js` has `sendMessage` and `editMessageText`

### What the spike proved
```javascript
// 1. Immediate ack
await tg.sendTyping(true);
const placeholder = await tg.sendMessage("🤔 Thinking...");

// 2. Background spawn + stream
child.stdout.on("data", (chunk) => {
  buf += chunk;
  if (buf.length >= 300) tg.editMessageText(placeholder, buf);
});

// 3. Final replace
tg.editMessageText(placeholder, finalText);
```

### What gets changed

| Component | Change |
|-----------|--------|
| `src/cli.js` | Add `runCliAsync()` with callback progress + cancellation |
| `src/index.js` | New `executePromptAsync()` using `runCliAsync()` |
| `src/messageDelivery.js` | New `sendMessageWithProgress()` (wrapper) |
| `src/bridge.js` | Add session message mapping for placeholder |
| `src/state.js` | Track in-flight session + placeholder IDs |
| `test/cli.test.js` | Async execution tests |
| `test/bridge.test.js` | Integration tests |

### Architecture decisions

1. **Non-ACP until fixed**: Use CLI spawn directly, not ACP runtime (gemini CLI bug)
2. **Graceful degradation**: Sync fallback if async fails
3. **Single conversation lock**: One async prompt per session at a time
4. **Edit throttling**: Debounce edits to 300-char chunks

## Mock/Testing Strategy

### Fixtures
- `test/fixtures/async-cli-response.json` — mock child process stdout
- `test/fixtures/progress-chunks.json` — streaming chunks

### Test types
- Unit: `runCliAsync()` with mocked spawn
- Integration: Full flow with in-memory Telegram mock
- E2E: Real CLI spawn in test environment

## Implementation Order (TDD-first)

### Phase 0 — Types & Contracts (Red → Green → Refactor)
0. Write failing test:
   ```javascript
   // test/cli.test.js
   it("runCliAsync returns progress via callback", async () => {
     const progressCalls = [];
     await runCliAsync(cmd, args, { onProgress: (text) => progressCalls.push(text) });
     expect(progressCalls.length).toBeGreaterThan(0);
   });
   ```
1. Add interfaces to `src/cli.d.ts`:
   ```typescript
   interface RunCliAsyncOptions extends RunCliOptions {
     onProgress?: (text: string) => void;
     onCancel?: (kill: () => void) => void;
   }
   interface RunCliAsyncResult { text: string; sessionId: string | null; }
   ```
2. Add stub `runCliAsync()` that forwards to `runCli()` (tests pass but no progress)

[Gate: compile + unit tests]

### Phase 1 — Async CLI runner (Red → Green → Refactor)
1. Write failing tests:
   - `runCliAsync` emits progress on stdout chunks
   - `runCliAsync` calls onCancel with kill function
   - `runCliAsync` handles CLI timeout gracefully
2. Implement `runCliAsync()` in `src/cli.js`:
   - Spawn with process group (`detached: false`, explicit group)
   - Stream stdout via `onProgress` callback
   - Wrap `onCancel` to kill process group
   - Maintain timeout + idle timeout from existing logic
3. Add `killChildTree()` for process group cleanup

[Gate: unit tests + CLI parse validation]

### Phase 2 — Progress-delivery wrapper (Red → Green → Refactor)
1. Write failing tests:
   - `sendMessageWithProgress` sends initial placeholder
   - `sendMessageWithProgress` updates on progress callback
   - `sendMessageWithProgress` replaces on final result
2. Implement `sendMessageWithProgress()` in `src/messageDelivery.js`:
   - Accept `execution` (runCliAsync result)
   - Send placeholder with typing
   - Wire progress callback to editMessageText
   - Final edit on complete

[Gate: unit tests]

### Phase 3 — Session state for async (Red → Green → Refactor)
1. Write failing tests:
   - Session tracks in-flight placeholder message ID
   - Cancel clears in-flight state
   - Concurrent prompts are rejected with "busy" message
2. Add to `src/state.js`:
   ```javascript
   // Track async session state
   asyncSession: { promptId, placeholderId, startedAt } | null
   ```
3. Update `executePromptAsync()` to check/reject concurrent prompts

[Gate: state tests + integration]

### Phase 4 — BridgeBot async integration (Red → Green → Refactor)
1. Write failing tests:
   - `BridgeBot.executePromptAsync()` sends immediate ack
   - Progress updates stream to user
   - Final replaces placeholder
   - Timeout falls back to sync or error message
2. Add `executePromptAsync()` in `src/index.js`:
   - Use `runCliAsync()` + `sendMessageWithProgress()`
   - Wire fallback for timeout/CLI error
   - Update `typingTracker` lifecycle

[Gate: integration tests]

### Phase 5 — Sync fallback + deployment (Red → Green → Refactor)
1. Write failing tests:
   - Async disabled falls back to existing sync flow
   - Service restart preserves session state
2. Add config toggle:
   ```javascript
   BRIDGE_ASYNC_ENABLED=true  // default: true
   ```
3. Preserve existing `executePrompt()` as fallback

[Gate: full test suite + staging deploy]

## Environment & Secrets

| Variable | Action | Notes |
|----------|--------|-------|
| `BRIDGE_ASYNC_ENABLED` | Add | Toggle async mode, default true |
| `CLI_PROGRESS_CHUNK_SIZE` | Add | Characters per edit (default: 300) |
| `CLI_EDIT_DEBOUNCE_MS` | Add | Debounce edits (default: 100ms) |

## Observability

```javascript
// Key log tags
"[async] prompt started"     // sessionId, promptId
"[async] progress"           // chunk length
"[async] completed"         // duration, charCount
"[async] cancelled"         // sessionId
"[async] fallback"         // reason (timeout | error)
```

## Success Criteria

| Metric | Target |
|--------|--------|
| First response time | < 2s (ack) |
| Progress updates | First within 30s |
| Graceful degradation | < 1s fallback |
| Concurrent rejection | Immediate "busy" |
| Test coverage | > 90% |

## Cost Model

| Scale | Async sync baseline |
|-------|-------------------|
| 100 prompts/day | $0 vs $0 (no change) |
| 500 prompts/day | $0 vs $0 (no change) |
| 1000 prompts/day | $0 vs $0 (no change) |

No external API changes — same CLI invocations.

## Modular Design (for other CLIs)

The `runCliAsync()` pattern is CLI-agnostic:

```javascript
// Generic signatures
runCliAsync(command, args, options, { onProgress, onCancel })
```

To add new CLI support:
1. Add CLI invocation builder in `src/cli.js`
2. Update `parseCliResult()` for output format
3. Tests verify async flow works

---

**Open decisions:**
- ACP runtime hang — defer to gemini CLI team
- Message threading — single placeholder vs inline edits
- Cancel UX — confirm before cancel or instant