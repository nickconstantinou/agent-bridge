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
