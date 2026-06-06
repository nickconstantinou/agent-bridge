# Bridge Event Normalization Research

## Status

**Phases 1-5 & Observability:** Completed.
**Phase 6 (Future Renderers / Protocol Mapping):** Deferred.

Research / architecture note. This document outlines the refactor path for introducing a normalized internal event contract into `agent-bridge` without changing current Telegram behaviour.

## Context

`agent-bridge` currently works well as a Telegram-facing bridge over three native coding CLIs:

```text
Telegram update -> BridgeBot -> CLI invocation -> CLI stdout/stderr/result -> Telegram response
```

The core execution path is concentrated in:

- `src/index.ts` — Telegram polling, routing, queueing, command handling, execution dispatch.
- `src/cli.ts` — CLI invocation construction, subprocess lifecycle, timeout/cancel handling, CLI-specific result parsing.
- `src/messageDelivery.ts` — Telegram typing indicators, final/error message sending, Telegram text splitting/entity rendering.
- `src/db.ts` — SQLite session IDs, locks, polling offsets, model settings, failure counters.
- `src/render.ts` — Telegram-safe text/entities rendering.

This design is direct and pragmatic, but it couples execution, streaming, lifecycle state, and Telegram rendering tightly together. That is fine while Telegram is the only surface. It becomes limiting if the bridge grows toward Discord, a web dashboard, richer approvals, artifact rendering, replay/debug timelines, or AG-UI/CopilotKit-style frontends.

## Problem Statement

The bridge does not currently have one normalized internal language for what happened during an agent run.

Instead, information is spread across:

- raw CLI stdout/stderr chunks
- parsed `CliResult` objects
- Telegram progress/final/error delivery decisions
- active process maps and abort state
- SQLite session rows and locks
- ad hoc logs

This makes it harder to add new renderers or observability without duplicating logic or reverse-engineering intent from text.

## Why This Is Worth Considering

The strategic benefit is optionality.

A normalized event layer would move agent-bridge from:

```text
Telegram wrapper around CLI agents
```

toward:

```text
agent execution core -> normalized bridge events -> any output surface
```

That unlocks:

1. **Multiple frontends**
   - Telegram
   - Discord
   - future web dashboard
   - future VS Code/mobile/OpenClaw UI
   - optional AG-UI/CopilotKit mapping later

2. **Better debugging and replay**
   - show exactly when a run started, streamed, failed, timed out, or was cancelled
   - replay a run timeline in logs or UI
   - inspect what the bridge thought happened, not just raw stdout

3. **Safer approvals**
   - approvals can become structured objects with stable IDs and command payloads
   - renderer buttons/modals can reference immutable event IDs
   - approval audit trails become possible

4. **Richer UX**
   - render progress cards, diffs, artifacts, file outputs, usage, test results
   - Telegram can stay text-first while other surfaces render richer UI

5. **Less duplicated rendering logic**
   - event producers express intent once
   - surface adapters handle platform constraints

6. **Future protocol compatibility**
   - internal events can be mapped outward to AG-UI or CopilotKit later
   - the bridge should not depend on React or CopilotKit to gain event normalization

## Non-Goals

This proposal does **not** recommend an immediate rewrite.

Out of scope for the first implementation slice:

- adding CopilotKit as a dependency
- adding AG-UI as a dependency
- building a web UI
- changing Telegram formatting
- changing approval semantics
- rewriting all CLI parsers
- storing every streaming token/delta forever
- replacing `BridgeBot` wholesale

## Key Risk

The main risk is turning a simple working bridge into an over-engineered event bus.

Specific risks:

1. **Telegram regression** — message chunking, code entities, timeout errors, `/stop`, or final-response behaviour could change.
2. **Parser overreach** — Codex, Claude, and Antigravity output different shapes; over-normalizing too early can lose useful CLI-specific details.
3. **Event explosion** — too many event types becomes harder to understand than the current direct flow.
4. **SQLite bloat** — storing every delta can grow databases quickly.
5. **Ordering bugs** — streaming, cancellation, timeout, and final delivery can race.
6. **Leaky abstractions** — Telegram, Discord, and web UI have different constraints; the common event model should express intent, not hide every platform difference.
7. **Approval safety bugs** — approval IDs and command payloads must never desynchronize.

## Recommended Design Principle

Introduce events as an internal adapter layer first, preserving current behaviour.

```text
Current path:
CLI output -> existing parsing/delivery -> Telegram

Low-risk transition:
CLI output -> existing parsing/delivery -> Telegram
          -> BridgeEvent debug stream/tests

Later:
CLI output -> BridgeEvent -> RunView/reducer -> Telegram renderer
                                      -> future Discord/Web/AG-UI renderer
```

## Proposed Minimal Event Contract

Start intentionally small.

```ts
export type BridgeEvent =
  | RunStartedEvent
  | TextDeltaEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent;

export interface BridgeEventBase {
  version: 1;
  id: string;
  runId: string;
  timestamp: string;
  bot: "codex" | "antigravity" | "claude";
  chatId: string;
  threadId?: string;
  sessionId?: string | null;
}

export interface RunStartedEvent extends BridgeEventBase {
  type: "run.started";
  model?: string | null;
  command: string;
  cwd: string;
}

export interface TextDeltaEvent extends BridgeEventBase {
  type: "text.delta";
  text: string;
  source: "stdout" | "stderr" | "parsed";
}

export interface RunCompletedEvent extends BridgeEventBase {
  type: "run.completed";
  text: string;
  sessionId: string | null;
  usage?: unknown;
}

export interface RunFailedEvent extends BridgeEventBase {
  type: "run.failed";
  error: string;
  category?: "cli" | "timeout" | "transport" | "render" | "unknown";
}

export interface RunCancelledEvent extends BridgeEventBase {
  type: "run.cancelled";
  reason: "user" | "shutdown" | "timeout";
}
```

Future event types can be added later only when there is a concrete consumer:

- `approval.requested`
- `approval.resolved`
- `artifact.created`
- `tool.call`
- `tool.result`
- `usage.reported`
- `session.updated`

## Proposed RunView Reducer

A reducer should turn events into a simple surface-neutral view:

```ts
export interface RunView {
  runId: string;
  status: "idle" | "running" | "done" | "failed" | "cancelled";
  text: string;
  error?: string;
  sessionId?: string | null;
  updatedAt: string;
}
```

Initial reducer rules:

- `run.started` sets `status = "running"`.
- `text.delta` appends to `text`.
- `run.completed` sets final `text`, `sessionId`, and `status = "done"`.
- `run.failed` sets `status = "failed"` and stores error text.
- `run.cancelled` sets `status = "cancelled"`.

This keeps the first reducer simple enough to test exhaustively.

## Current Files Affected

### Add

- `src/events/types.ts` — event interfaces and type guards.
- `src/events/reducer.ts` — `BridgeEvent[] -> RunView` reducer.
- `src/events/emitter.ts` — lightweight in-process emitter or collector, initially test/log oriented.
- `test/events.test.ts` — unit tests for event schema and reducer.
- `docs/bridge-event-normalization-research.md` — this document.

### Change, incrementally

- `src/cli.ts`
  - optionally emit `run.started`, `text.delta`, `run.completed`, `run.failed`, `run.cancelled` from `runCliAsync` without changing return values.
  - keep current `CliResult` contract intact in early phases.

- `src/messageDelivery.ts`
  - initially unchanged.
  - later add `sendRunViewWithProgress` or equivalent only after parity tests exist.

- `src/index.ts`
  - initially pass run metadata where needed.
  - later route execution through event adapter once parity is proven.

- `src/db.ts`
  - no immediate schema change.
  - later add event persistence tables only for coarse lifecycle/final events.

### Do Not Change Initially

- Telegram auth and polling behaviour.
- CLI command construction.
- Markdown/entity rendering.
- `/stop`, `/reset`, `/models`, `/usage` command semantics.
- Timeout defaults.
- Service unit files.

## Implementation Plan

## TDD commit discipline — applies to every phase below

Each phase that introduces new behaviour must follow this sequence without exception:

1. Write the tests described in that phase.
2. Run `npm test` — confirm the new tests **fail**. If they do not fail, stop: the test is wrong or already covered.
3. Commit the failing tests: `test: <phase description>` ← red state
4. Write the minimal production code to pass them.
5. Run `npm test` — confirm all tests **pass**.
6. Commit the implementation: `feat/fix: <phase description>` ← green state
7. Refactor if needed, keeping tests green throughout.

Never bundle test files and production code in a single commit. The commit history must prove the red state existed before the implementation.

---

### Phase 0 — Characterisation Tests (Completed)

Goal: capture current observable behaviour before architecture changes.

Add or strengthen tests around:

- final message delivery for Codex, Claude, and Antigravity
- progress callback accumulation
- timeout error formatting
- `/stop` abort behaviour
- `/reset` session clearing
- Telegram code-block entity rendering
- Telegram chunk splitting
- Codex JSON progress filtering

TDD sequence: these tests should be green immediately (they describe existing behaviour). If any are red, that is a bug — fix it before proceeding. Commit characterisation tests as a single `test:` commit before any production code changes.

Gate:

```bash
npm run typecheck
npm test   # all characterisation tests must pass
```

No production code should change in this phase unless a missing test fixture requires minor test-only scaffolding.

### Phase 1 — Add Event Types and Reducer Only (Completed)

Goal: introduce the contract with no runtime behaviour change.

TDD sequence:
1. Add `test/events.test.ts` with the failing tests listed below. Run `npm test` — confirm red.
2. Commit: `test: failing tests for BridgeEvent types and reducer`
3. Add `src/events/types.ts` and `src/events/reducer.ts`. Run `npm test` — confirm green.
4. Commit: `feat(events): add BridgeEvent contract and RunView reducer`

Tests (all must be red before implementation):

- reducer starts a run on `run.started`
- appends text deltas in order on `text.delta`
- `run.completed` overrides interim text with final text
- `run.failed` stores error category and message
- `run.cancelled` sets status to cancelled
- unknown/future-safe handling is explicit — compile-time impossible or test-covered

Gate:

```bash
npm run typecheck
npm test   # all tests pass; events.test.ts tests are green
```

### Phase 2 — Emit Events in Parallel (Completed)

Goal: event emission exists, but Telegram behaviour is still driven by the current code path.

TDD sequence:
1. Add failing tests for event emission in `test/events.test.ts` or `test/cli.test.ts`. Run `npm test` — confirm red.
2. Commit: `test: failing tests for runCliAsync event emission`
3. Add `onEvent` callback and emission in `runCliAsync`. Run `npm test` — confirm green.
4. Commit: `feat(events): emit BridgeEvents from runCliAsync`

Implementation sketch:

- Add optional `onEvent?: (event: BridgeEvent) => void` to internal execution options.
- In `runCliAsync`, emit:
  - `run.started` after spawn succeeds
  - `text.delta` from stdout/stderr chunks
  - `run.completed` on successful close/parse
  - `run.failed` on non-zero exit/hard timeout/idle timeout
  - `run.cancelled` for user aborts
- Keep existing `onProgress` and `CliResult` behaviour unchanged.

Tests (all must be red before implementation):

- `runCliAsync("echo")` emits `run.started`, `text.delta`, `run.completed` in order.
- idle timeout emits `run.failed` with `category = "timeout"`.
- abort emits `run.cancelled` without changing existing abort resolution expectations.
- no Telegram test expectations change.

Gate:

```bash
npm run typecheck
npm test   # all existing tests still pass; new emission tests green
```

### Phase 3 — Build Telegram Parity Adapter Behind Tests (Completed)

Goal: prove events can produce the same final Telegram output without switching production yet.

TDD sequence:
1. Add failing tests for `runViewToTelegramText`. Run `npm test` — confirm red.
2. Commit: `test: failing parity tests for runViewToTelegramText`
3. Implement the adapter. Run `npm test` — confirm green.
4. Commit: `feat(events): Telegram parity adapter runViewToTelegramText`

Add a pure adapter function:

```ts
runViewToTelegramText(view: RunView): string
```

Tests (all must be red before implementation):

- current final text → same Telegram text
- error event → same `❌ ...` text as `sendMessageWithProgress`
- code block text still flows through existing `toTelegramEntitiesText`
- long text still uses existing `splitTelegramText`

Gate:

```bash
npm run typecheck
npm test   # parity adapter tests green; no existing test changes
```

### Phase 4 — Switch One Narrow Path to Events (Completed)

Goal: migrate one low-risk path first.

Candidate path:

- final-only successful response for a mocked execution in tests, not live CLI streaming.

Do not start with:

- live streaming
- attachments
- `/stop`
- timeouts
- Antigravity delimiter parsing

TDD sequence:
1. Add failing acceptance tests proving the narrow path produces identical Telegram output via events. Run `npm test` — confirm red.
2. Commit: `test: failing acceptance tests for event-driven narrow path`
3. Migrate the path. Run `npm test` — confirm green.
4. Commit: `feat(events): route narrow success path through event adapter`

Acceptance:

- messageDelivery tests remain semantically identical
- no new live-service behaviour observed

### Phase 5 — Coarse Event Persistence (Completed)

Goal: add audit/replay value without DB bloat.

Potential schema:

```sql
CREATE TABLE IF NOT EXISTS bridge_runs (
  run_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  bot TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  session_id TEXT,
  final_text_preview TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS bridge_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES bridge_runs(run_id)
);
```

Implemented persistence policy:

- `BridgeEngine` creates one run context per prompt execution and persists coarse lifecycle state to `bridge_runs` / `bridge_events`
- persist the first `run.started` immediately, including command/cwd/model metadata in the event payload
- keep `text.delta` events in memory only by default; do not write high-volume deltas to SQLite
- defer `run.completed` persistence until the parsed, authoritative final text and session ID are available
- persist `run.failed` and `run.cancelled` as terminal events when emitted by the CLI execution path
- enable SQLite foreign key enforcement so `bridge_events.run_id` must reference an existing `bridge_runs.run_id`
- disable `sendMessageWithProgress` synthetic lifecycle events for real engine CLI paths so production runs do not record duplicate `run.started` / `run.completed` events
- artifact metadata remains future work when artifact events are introduced

Tests:

- migration creates tables idempotently
- inserting events preserves ordering
- final run summary can be queried
- DB remains backward-compatible with existing `bridge_state`
- production async engine execution persists one run, lifecycle-only events, and the final parsed response/session

### Phase 6 — Future Renderers / Protocol Mapping (Deferred)

Deferred. Future work to support:

- Discord renderer
- WebSocket renderer
- AG-UI/CopilotKit mapper
- richer approval events
- artifact/diff cards

## Observability

Add structured log tags only after event generation exists:

```text
[event] run.started runId=... bot=... chatId=...
[event] run.completed runId=... sessionId=...
[event] run.failed runId=... category=timeout error="..."
```

Avoid logging full prompts, secrets, raw env, or sensitive command payloads.

## Success Criteria

The refactor is successful only if:

- all current tests pass
- current Telegram behaviour is unchanged
- event reducer tests are deterministic
- event emission can be disabled or ignored without functional impact
- no significant DB growth occurs
- no approval or command execution safety semantics change
- service restart behaviour remains unchanged

## Rollback Plan

Because event emission should be additive in early phases, rollback should be simple:

1. Stop passing `onEvent` callbacks.
2. Leave event types/reducer in code if harmless, or remove them in one commit.
3. Re-run `npm run typecheck && npm test`.
4. Restart systemd services only if production code changed.

No database rollback should be needed until Phase 5. If Phase 5 introduces tables, rollback can leave unused tables in place unless they cause measurable issues.

## Recommendation

Proceed only if the near-term goal includes at least one of:

- Discord support
- web dashboard
- approval UX improvements
- audit/replay/debug tooling
- artifact/diff rendering
- future AG-UI/CopilotKit compatibility

If agent-bridge will remain Telegram-only with plain text responses, this refactor is not worth the complexity.

Given the current direction of the project, the improvement is worth doing, but only as an incremental refactor with strict parity tests and no CopilotKit dependency in the first slice.
