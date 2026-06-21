# Agent-Driven Memory Broker Research

Research plus implementation plan. Phases 1-4 are implemented as of
2026-06-21. This document defines how Agent Bridge can move from the external
`agent-memory` CLI toward a bridge-owned, agent-driven memory broker.

## Goal

Give Codex, Claude, and Antigravity shared durable memory without making the
user manage `/remember` commands. The bridge should retrieve and write memories
based on the active conversation, task, repo, and agent behavior.

The bridge DB should become the memory substrate, but compact conversation
summaries should remain conversation continuity. Durable project memory needs a
dedicated table, retrieval path, and write policy.

## Current State

`agent-memory` is a shell-callable SQLite CLI at:

```text
/home/content-crawler/.agent-bridge/shared-memory/agent-memory.sqlite
```

Observed audit on 2026-06-21:

| Check | Result |
|---|---|
| Total memories | 161 |
| Scope | all `project` |
| Type spread | 157 `decision`, 2 `bug`, 1 `bug_fix`, 1 `bugfix` |
| Storage behavior | Good for durable decisions when agents remember to write |
| Retrieval behavior | Mixed; lexical FTS/LIKE misses related wording |

Retrieval probes:

| Query | Result |
|---|---|
| `fallback cli promotion` | Hit correct memory |
| `conversation startup cleanup` | Hit correct memory |
| `worker merge gate` | Hit correct memory |
| `chunked compact summaries` | Missed relevant `/compact` memory |
| `agent bridge context helper` | Missed relevant context memories |

## Problem

The current memory layer depends on agent discipline:

- Agents must remember to call `agent-memory recall`.
- Agents must decide when to call `agent-memory add`.
- Retrieval is keyword-sensitive, not semantic.
- Memory is not automatically scoped to the current conversation.
- Type names drift (`bug_fix` vs `bugfix`).
- There is no dedupe, supersession, confidence, or provenance model.

## Design Principle

Do not inject global "top memories" by default. That risks stale or irrelevant
context. Use conversation-aware memory instead:

```text
current user prompt
  + latest compact summary
  + recent turns
  + active repo/workspace
  + CLI kind
  + explicit task signals
        |
        v
conversation-aware memory query pack
        |
        v
agent decides what to read, cite, apply, or write
```

The bridge should provide memory affordances and candidate packs. The agent
should make final relevance decisions because it sees the actual task and can
distinguish useful precedent from noise.

Implemented behavior: the bridge exposes helper commands inside spawned CLI
environments. It does not inject raw memory text by default. Agents can retrieve
conversation-aware memories via `--memory`, narrow with `--memory-query`, and
write durable candidates via `--memory-add-json` or a post-turn sidecar.

## Proposed Architecture

### Memory Tables

Add bridge-owned project memory tables instead of overloading
`conversation_summaries`:

```sql
CREATE TABLE project_memories (
  id              TEXT PRIMARY KEY,
  scope           TEXT NOT NULL CHECK (scope IN ('project','chat','global')),
  type            TEXT NOT NULL CHECK (type IN ('decision','bug','convention','todo','note')),
  text            TEXT NOT NULL,
  source_chat_key TEXT,
  source_turn_id  INTEGER,
  repo_path       TEXT,
  supersedes_id   TEXT,
  confidence      REAL NOT NULL DEFAULT 1.0,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE VIRTUAL TABLE project_memories_fts
USING fts5(id UNINDEXED, text, content='project_memories', content_rowid='rowid');
```

Keep `conversation_summaries` for chat continuity:

| Table | Purpose |
|---|---|
| `conversation_summaries` | "What happened in this chat/thread?" |
| `conversation_turns` | "What happened since compact?" |
| `project_memories` | "What should future agents know?" |

### Conversation-Aware Retrieval

Before each CLI call, the bridge builds a query pack from:

- current user prompt
- latest compact summary
- recent raw turns
- active `chatKey`
- repo/workspace path
- task type hints from the prompt

The bridge should not inject all matches. It should expose:

```text
[Agent Bridge memory]
Conversation-aware project memory is available.
"$AGENT_BRIDGE_CONTEXT_COMMAND" --memory
"$AGENT_BRIDGE_CONTEXT_COMMAND" --memory-query "<query>"
"$AGENT_BRIDGE_CONTEXT_COMMAND" --memory-add-json '<json>'
```

The default `--memory` query should use the bridge-built query pack. The agent
can call `--memory-query` for narrower follow-up retrieval when the task reveals
more context.

### Agent-Driven Writes

Writes should be agent-driven, not user-command-driven.

Preferred write path:

1. Agent completes meaningful work.
2. Agent proposes memory candidates in a structured internal block or via a
   helper command.
3. Bridge validates:
   - no secrets
   - durable fact, decision, bug, convention, or unresolved TODO
   - project-relevant
   - not a duplicate of an existing active memory
4. Bridge stores accepted candidates with provenance.

Candidate shape:

```json
{
  "type": "decision",
  "scope": "project",
  "text": "Agent Bridge interactive fallback persists the first successful fallback CLI.",
  "source": "agent",
  "confidence": 0.9
}
```

The first implementation can use an explicit helper command called by the agent,
not the user:

```bash
$AGENT_BRIDGE_CONTEXT_COMMAND --memory-add-json '<json>'
```

The bridge also parses hidden post-turn sidecars from successful agent output,
stores valid candidates, and strips the sidecar before delivery and history
persistence:

```html
<!-- agent-bridge-memory
[
  {
    "type": "decision",
    "scope": "project",
    "text": "Agent Bridge memory sidecars are stripped before Telegram delivery.",
    "confidence": 0.8
  }
]
-->
```

Implemented guardrails:

- allowed types: `decision`, `bug`, `bugfix`, `bug_fix`, `convention`, `todo`,
  `note`
- allowed scopes: `project`, `chat`, `global`
- rejects empty, short, long, duplicate, transient, and secret-looking text
- stores `source_chat_key`, `source_cli`, latest turn id, repo path, confidence
- returns a short status such as `Memory stored: <id>`,
  `Memory duplicate: <id>`, or `Memory rejected: <reason>`

## Phased Implementation Plan

### Phase 1: Retrieval Broker, Read-Only

Status: implemented on 2026-06-21.

Red -> green requirements:

- Add `project_memories` schema beside existing bridge DB tables.
- Add import/migration from existing `agent-memory` DB.
- Add read-only context helper flags:
  - `--memory`
  - `--memory-query <query>`
- Build query pack from current prompt + compact summary + recent turns.
- Inject only the memory affordance and a small candidate count, not raw memory
  text by default.

Acceptance:

- A prompt about "chunked compact summaries" retrieves the existing
  "chunked map-reduce compaction" memory.
- A prompt about "fallback keeps retrying Claude" retrieves the fallback CLI
  promotion memory.
- No memories are injected when the DB has no relevant matches.

### Phase 2: Better Lexical Retrieval

Status: implemented on 2026-06-21.

Red -> green requirements:

- Normalize tokens: hyphens, slashes, stemming-like aliases, singular/plural.
- Add synonym expansion for bridge vocabulary:
  - `compact`, `compaction`, `summary`, `summarisation`
  - `fallback`, `switch`, `promotion`, `persistent cli`
  - `context`, `conversation`, `history`
- Return snippets and scores, not only full text.

Acceptance:

- Current failed probes from the audit become hits.
- Results include `id`, `type`, `score`, `snippet`, and full text on demand.

Implementation note: the first pass remains deterministic. It normalizes
hyphens, punctuation, singular/plural-ish endings, and expands a small bridge
vocabulary map for compact/summary, fallback/switch/promotion, context/history,
and memory/recall terms before querying FTS5.

### Phase 3: Agent-Driven Writes

Status: implemented on 2026-06-21.

Red -> green requirements:

- Add a write helper available only inside the CLI child environment.
- Validate memory type/scope/text.
- Reject empty, duplicate, secret-looking, and purely transient memories.
- Store source metadata: `chatKey`, latest turn id, CLI kind, repo path.

Acceptance:

- Agent can store a durable decision without a user command.
- Duplicate write is ignored or links to the existing memory.
- Secret-like text is rejected and not persisted.

### Phase 4: Post-Turn Memory Candidate Extraction

Status: implemented on 2026-06-21.

Options:

| Option | Behavior | Risk |
|---|---|---|
| Agent self-write | Agent calls helper when it judges memory is durable | Depends on agent discipline |
| Structured final sidecar | Agent includes memory candidates in a hidden parseable block | Output parsing risk |
| Bridge extractor | Bridge runs a separate post-turn summarizer | Extra LLM call, cost, latency |

Recommended first production path: agent self-write with strict validation.

Implemented path: structured final sidecar. The bridge does not run a separate
LLM extractor. Agents may include `<!-- agent-bridge-memory ... -->` or
`<agent-bridge-memory>...</agent-bridge-memory>` containing one candidate object
or an array of candidates. The engine strips the sidecar before Telegram
delivery, conversation persistence, and `onAfterExecute` hooks. Valid candidates
use the same validator as `--memory-add-json`; invalid candidates are ignored.

## Non-Goals

- Do not replace `/compact`; it remains chat continuity.
- Do not inject global top memories into every prompt.
- Do not store secrets, tokens, private personal details, or raw long logs.
- Do not delete the external `agent-memory` DB until import/export parity exists.
- Do not add embeddings on the first pass.

## Decisions

- Project memory should live in one shared bridge-owned DB path. Bot-specific
  DBs should keep transport and runtime state, not independent memory copies.
- Discord and Telegram should share project memory by repo path. `chatKey`,
  channel, platform, and CLI kind should be stored as provenance metadata and
  optional filters, not the default isolation boundary.
- Accepted memory candidates should produce a short user-visible audit line,
  for example: `Memory: stored 1 decision, rejected 1 duplicate`. Default
  output should stay count-only unless a verbose/debug mode is requested.
- The first secret detector should combine precise regexes, a denylist, and
  entropy checks. It should reject obvious API keys, tokens, private keys,
  password assignments, `.env`-style secrets, and long high-entropy strings.
- Superseded memories should stay in the DB for audit history but be hidden
  from default retrieval. Add an explicit `--include-superseded` path for
  inspection and migration checks.

## Verification Plan

- Unit tests for schema, import, retrieval, and validation.
- Regression tests for the five audit queries listed above.
- Integration test that a fallback CLI receives the same memory affordance.
- Manual smoke test using a real bridge turn:
  - ask about fallback CLI promotion
  - agent retrieves relevant memory through helper
  - agent stores a new durable implementation decision
  - next CLI can retrieve it without external `agent-memory`
