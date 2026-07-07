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

For the interactive/companion bot:

- native CLI session IDs should maintain continuity while the same provider session is active;
- manual provider switching should start a fresh target CLI session;
- capacity fallback should start a fresh target CLI session;
- Agent Bridge should inject handoff context only on the first turn of a fresh target CLI session;
- after a successful first target response, the target CLI session ID should be stored and Agent Bridge should stop injecting the full handoff context on every turn.

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
