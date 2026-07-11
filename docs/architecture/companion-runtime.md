# Companion Runtime Architecture

## Status

Canonical architecture documentation.

## Purpose

The Companion Runtime is the domain-agnostic conversational runtime inside Agent Bridge OSS.

It exposes one or more AI runtimes through chat or future TUI surfaces and manages conversation routing, sessions, fallback, memory use, and response delivery.

## Responsibilities

The Companion Runtime owns:

- Telegram conversational surfaces
- Discord conversational surfaces
- future chat/TUI transports
- conversation routing
- provider selection
- per-conversation session management
- usage monitoring
- provider/model fallback
- memory retrieval/write seams
- capability invocation through the Shared Runtime
- response rendering and delivery

## Frontier Advisor

The optional advisor lets a standard executor consult up to two ordered
frontier provider/model targets without changing its active provider or native
session. It is disabled by default.

- `manual`: explicit `/advisor ask|review|plan|debug` commands and direct agent
  calls through `AGENT_BRIDGE_ADVISOR_COMMAND` invoke the advisor.
- `suggest`: complex, risky, or stuck prompts pause for explicit approval.
- `auto`: those prompts consult the advisor and fold structured guidance into
  the executor prompt. Operational advisor failure is fail-open.

Fallback occurs only for authentication, capacity, unavailable model/provider,
timeout, transient failure, or invalid structured output. A valid opinion is
never retried merely because the executor disagrees. The advisor is trusted for
reasoning; merge, deploy, approval, deletion, final-message, and session
authority remain with Agent Bridge and its existing gates.

Bridge-spawned CLI agents receive `AGENT_BRIDGE_ADVISOR_COMMAND` and a
turn-scoped budget key. When enabled, the prompt advertises this command:

```bash
"$AGENT_BRIDGE_ADVISOR_COMMAND" --mode review --task "Review this plan"
```

Supported agent modes are `plan`, `review`, `debug`, `risk`, and `decision`.
The helper binds calls to the active chat and workspace, uses the same ordered
fallback chain and structured-output parser as `/advisor`, and writes the same
logical-call and per-attempt audit records. Advice remains non-authoritative.

## Flow

```text
Transport
→ Conversation router
→ Provider selection
→ Session management
→ Usage monitoring
→ Fallback
→ Memory
→ Capability/tool execution
→ Response
```

## Supported Use Cases

The Companion Runtime should support domain-agnostic requests such as:

- summarise a meeting
- research a topic
- translate a document
- plan travel
- draft prose
- explain a technical concept
- answer questions using configured capabilities

## Memory and Provider Handoff

The Companion Runtime should preserve continuity across provider switching without repeatedly injecting full Agent Bridge context into every turn.

**Current implementation (issue #69 PR 6 + context injection policy):**

- manual provider switching and capacity fallback both clear the target CLI's session (`db.setSession(chatKey, targetCli, null)`) so it starts fresh rather than resuming a possibly stale, long-abandoned native session;
- fallback additionally compacts the outgoing CLI's conversation first (rate-limited by `fallbackCompactCooldown.ts`) and promotes durable memory candidates, so the target CLI's context is a fresh summary rather than raw un-compacted turns; compaction failure never blocks the fallback itself;
- a one-time `handoff_required:<chatKey>:<cliKind>` flag (`src/handoffState.ts`) is set on the target;
- `BridgeEngine._shouldInjectContext()` gates full context injection on a configurable policy, `BRIDGE_CONTEXT_INJECTION_POLICY`:
  - `always` (default): inject on every turn regardless of session/handoff state — preserves the original OSS behavior exactly, so existing self-hosted deployments see no change.
  - `handoff_once`: inject only when there is no native CLI session for this chat+CLI (covers first-ever turn, `/compact` reset, and invalid-session retry, since all three clear the session and retry with `sessionId: null`), or when the handoff flag is pending. Consumed (cleared, logged) on the turn that actually receives it — never consumed on a turn the policy suppresses (e.g. `/reset`'s `ctx_suppress` always wins over a pending handoff mark).
  - `AGENT_BRIDGE_CONTEXT_COMMAND`/`AGENT_BRIDGE_CONTEXT_DB`/`AGENT_BRIDGE_CHAT_KEY`/`AGENT_BRIDGE_CLI_KIND` env vars remain available under both policies regardless of whether the prompt preamble is injected, so the CLI can always self-serve query context via `agent-bridge-context`.
- Minimal pre-seed compaction (`BRIDGE_PRESEED_COMPACT_MODE`, default `off`): under `handoff_once`, on a turn that is about to inject full context into a fresh provider session, `BridgeEngine._maybePreseedCompact()` checks `db.getUncompactedConvStats(chatKey)` and — when mode is `auto` and the un-compacted char count exceeds `BRIDGE_PRESEED_COMPACT_CHARS` (default `30000`) — runs `compactConversation()` first, so the injected context is a fresh summary rather than a large raw-turn dump. Skipped when zero turns are un-compacted or a compaction is already in progress (`compact_in_progress:<chatKey>`); any failure is logged and swallowed, never blocking the turn.
- Platform-managed workspaces should set `handoff_once`, `BRIDGE_PRESEED_COMPACT_MODE=auto`, and `BRIDGE_PRESEED_COMPACT_CHARS=30000` — see `docs/architecture/platform-boundary.md`.
- `/context` (`handleCommand`, `src/commands.ts`) is an operator diagnostics command, not a memory browser: it reports the injection policy, pre-seed compact mode/threshold, uncompacted turn/char counts, and a memory *count*. It never lists or renders memory contents. Durable memory is agent-facing only — subprocess CLIs read it via `agent-bridge-context --memory`/`--memory-query`/`--memory-add-json` (`src/contextCommand.ts`). There is no human-facing `/memory` Telegram command, and none is currently planned; memory is long-term recall for agents, not an operator-facing notes feature.

Handoff context should be built from:

- the latest compact summary;
- the latest N recent turns after that summary, bounded by the configured context budget;
- memory-search instructions and guidance;
- persistent memories only when searched or explicitly selected by the agent.

The canonical memory and handoff design is `docs/architecture/memory-and-handoff.md`.

## Explicit Non-Responsibilities

The Companion Runtime must not own or depend on Engineering Worker concepts:

- repositories
- work items
- worker jobs
- Git branches
- TDD phases
- CI state
- pull requests
- reviewer comments
- merge approval gates

If a conversational surface needs to trigger engineering work, it should do so through an explicit worker command/API boundary, not by importing worker internals.

## Compatibility

Current service names such as interactive Telegram and Discord services may remain unchanged for compatibility. The architectural term is Companion Runtime even where legacy file, service, or environment names still say interactive or bot.
