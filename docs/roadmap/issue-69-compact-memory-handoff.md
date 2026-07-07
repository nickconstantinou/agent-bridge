---
status: active-roadmap
type: roadmap
authority: canonical
implementation_status: planned
last_validated_against: issue-69
---

# Issue #69 Implementation Plan: Compact Memory and CLI Handoff

## Scope

This plan implements the architecture in `docs/architecture/memory-and-handoff.md`.

It is a TDD-first plan for issue #69:

- remove the post-turn memory extractor;
- make compaction the only automatic durable-memory distillation path;
- promote persistent memory candidates from compact summaries;
- add companion and engineering compact profiles;
- unify manual switch and fallback handoff context;
- inject Agent Bridge context once when starting a fresh provider session;
- fix recent-turn handling when more than 200 turns exist after the latest summary.

## Current Implementation Areas

Expected files to change or remove:

```text
src/engine.ts
src/compactSummary.ts
src/projectMemory.ts
src/repositories/memoryRepository.ts
src/repositories/sessionRepository.ts
src/contextCommand.ts
src/interactiveBot.ts
src/index-interactive.ts
src/index.ts
src/index-worker.ts
src/db.ts
src/memoryExtractor.ts              # remove
```

Expected test areas:

```text
test/ or src/**/*.test.ts around:
- compact summary prompt construction
- BridgeEngine prompt construction
- interactive fallback dispatch
- session persistence
- project memory candidate storage
- context command rendering/search
```

Expected docs to update:

```text
README.md
docs/README.md
docs/architecture/memory-and-handoff.md
docs/architecture/companion-runtime.md
docs/architecture/shared-runtime.md
docs/roadmap/issue-69-compact-memory-handoff.md
AGENTS.md or agents.md if it contains memory guidance
```

## Implementation Principles

1. Prefer one shared service path over duplicated compact logic.
2. Preserve raw turns unless a useful summary has been stored successfully.
3. Do not silently mutate memory after every turn.
4. Provider-native sessions own continuity after the first handoff turn.
5. Agent Bridge owns cross-provider handoff continuity.
6. Fallback must continue even if compaction fails.
7. Prompt context should favor newest recent turns, not oldest un-compacted turns.
8. Persistent memories must pass existing validation before storage.

## Phase 0 — Characterisation Tests

Create failing tests that capture current gaps before implementation.

### Tests

- A normal successful turn currently calls the post-turn extractor when enabled; new expected behavior is that no post-turn extractor exists or runs.
- Current prompt construction repeatedly injects Agent Bridge context even when continuing the same interactive CLI session; new expected behavior is one-time injection for fresh/handoff sessions.
- Current recent context handling with more than 200 turns after the latest summary should prove whether newest turns are omitted; new expected behavior is latest N turns.
- Current `/compact` tombstone fallback should prove raw turns can be pruned after weak fallback; new expected behavior is non-destructive failure.

### Exit Criteria

- Failing tests clearly express the desired behavior.
- No production code changes except test helpers.

## Phase 1 — Remove Post-Turn Extractor

### Production Changes

- Delete `src/memoryExtractor.ts`.
- Remove `BRIDGE_MEMORY_EXTRACTOR_ENABLED` checks.
- Remove `_extractPostTurnMemories()` from `BridgeEngine`.
- Remove async and sync calls after `_rememberTurn()`.
- Remove or update extractor-specific docs.

### Preserve

- Sidecar/manual memory writes if still desired.
- `storeProjectMemoryCandidate()`.
- `project_memories` table and FTS triggers.
- `agent-bridge-context --memory` and `--memory-query`.

### Tests

- Successful turns store conversation turns only.
- No second model/CLI call occurs after a normal response.
- Existing sidecar/manual memory storage still works, if retained.

### Exit Criteria

- Post-turn extraction path cannot run.
- Test suite has no references to `BRIDGE_MEMORY_EXTRACTOR_ENABLED` except migration/removal notes if necessary.

## Phase 2 — Compact Result Contract

### Production Changes

Introduce a compact result parser and prompt contract.

Suggested type:

```ts
export interface CompactResult {
  summary_md: string;
  memory_candidates: ProjectMemoryCandidate[];
}
```

Compaction prompt should require JSON output:

```json
{
  "summary_md": "Current objective:\n- ...\n\nDurable facts:\n- ...\n\nOpen state:\n- ...",
  "memory_candidates": []
}
```

Parser requirements:

- accept strict JSON;
- optionally tolerate fenced JSON;
- validate `summary_md` exists and is non-empty;
- default `memory_candidates` to `[]`;
- reject invalid result as compaction failure;
- keep summaries bounded by a configured maximum.

### Tests

- Parses valid compact JSON.
- Rejects missing/empty `summary_md`.
- Treats malformed JSON as compaction failure.
- Accepts fenced JSON only if existing CLI behavior requires it.

### Exit Criteria

- Compaction output is structured.
- The rest of the system no longer needs to parse durable facts out of Markdown bullets.

## Phase 3 — Compact Profiles

### Production Changes

Extend `compactSummary.ts` or a new `compactPrompts.ts` to support:

```ts
type CompactProfile = "companion" | "engineering";
```

Profile selection:

- Companion Runtime / interactive bot: `companion`.
- Engineering Worker: `engineering`.
- Individual CLI bots: default `companion`, configurable if needed.

Environment override may be useful:

```text
AGENT_BRIDGE_COMPACT_PROFILE=companion|engineering
```

### Companion Prompt Requirements

Preserve:

- user preferences;
- constraints;
- named people/projects/entities;
- recurring context;
- decisions;
- health/training/travel/home/work context when relevant;
- technical or project context when relevant;
- open questions and next actions.

### Engineering Prompt Requirements

Preserve:

- repo, branch, PR/issue IDs;
- file paths;
- commands/test results;
- architecture decisions;
- implementation choices;
- worker job IDs;
- approvals/blockers/failing checks.

### Tests

- Companion prompt does not say every conversation is with a coding assistant.
- Companion prompt preserves non-engineering durable facts.
- Engineering prompt preserves repo/PR/file/test data.
- Profile selection is deterministic.

### Exit Criteria

- Companion and engineering compaction are separate and tested.

## Phase 4 — Shared Compaction Service

### Production Changes

Create a service boundary, for example:

```ts
compactConversation(input: {
  db: BridgeDb;
  chatKey: string;
  cliKind: BotKind;
  profile: CompactProfile;
  mode: "manual" | "fallback_handoff" | "switch_handoff" | "scheduled";
  summarize: (prompt: string) => Promise<string>;
  pruneOnSuccess?: boolean;
}): Promise<CompactConversationResult>
```

Responsibilities:

- load previous summary;
- load all un-compacted turns since previous summary;
- chunk all un-compacted turns;
- summarise chunks;
- reduce previous summary + chunks;
- parse `CompactResult`;
- store summary only on success;
- promote memory candidates through `storeProjectMemoryCandidate()`;
- prune turns only after summary storage succeeds and `pruneOnSuccess` is true;
- return rejected/duplicate candidate metadata.

### Failure Semantics

On failure:

- do not store a new summary;
- do not prune raw turns;
- do not clear useful context;
- return error metadata;
- caller decides whether to continue.

### Tests

- Manual compact success stores summary and prunes covered turns.
- Compact failure leaves raw turns intact.
- Compact failure leaves latest previous summary intact.
- Memory candidates are promoted through validation.
- Duplicate/rejected candidates do not fail compact.
- Chunking includes all un-compacted turns.

### Exit Criteria

- `/compact` and fallback can call the same service.

## Phase 5 — Fix Recent-Turn Retrieval

### Problem

Handoff context currently risks using the first N turns after a summary instead of the latest N turns. With more than 200 turns since the latest summary, newest turns may be omitted.

### Production Changes

Add APIs that separate prompt-context retrieval from compaction retrieval:

```ts
getRecentConvTurnsAfterSummaryTail(chatKey, limit, sinceId)
getConvTurnsForCompaction(chatKey) // all un-compacted turns
```

Prompt/handoff context should use:

```text
latest summary + latest N turns after summary within char budget
```

Compaction should use:

```text
all turns after latest summary, chunked
```

Suggested config:

```text
BRIDGE_CONTEXT_RECENT_TURN_LIMIT=200
BRIDGE_CONTEXT_MAX_CHARS=8000
BRIDGE_COMPACT_AUTO_TURN_THRESHOLD=200
```

### Tests

- Create summary at turn 10, then 250 new turns.
- Handoff context includes the newest turns, not the oldest turns after turn 10.
- Compaction includes all 250 turns through chunking.
- Char budget still applies after selecting latest N candidates.

### Exit Criteria

- No newest-turn loss when un-compacted backlog exceeds 200 turns.

## Phase 6 — One-Time Handoff Context

### Production Changes

Add handoff state.

Minimal implementation can use `settings`:

```text
handoff_required:<chatKey>:<cliKind> = 1
handoff_reason:<chatKey>:<cliKind> = first_turn | manual_switch | fallback | compact | invalid_session
```

A dedicated table may be introduced if cleaner.

Modify prompt building:

```text
if handoff required or no native session exists and runtime policy requires first-turn seeding:
  inject handoff context
else:
  do not inject full Agent Bridge context
```

After successful CLI response with a stored session ID:

```text
clear handoff_required
clear handoff_reason
```

### Runtime Policies

Individual CLI bots:

- primarily rely on native session continuity;
- inject only when no native session exists, after `/compact`, or after invalid-session retry if configured.

Interactive/companion bot:

- inject on first fresh target CLI session;
- inject after manual switch;
- inject after fallback;
- inject after `/compact` resets session;
- do not inject repeatedly while the same CLI session continues.

### Tests

- First interactive turn injects handoff context.
- Second same-CLI turn does not inject handoff context.
- `/compact` marks handoff required for next turn.
- Invalid native session retry injects once.
- Empty DB first turn does not invent fake context; it may include SOUL.md only.

### Exit Criteria

- Handoff context is one-time per fresh provider session.

## Phase 7 — Manual CLI Switch Handoff

### Production Changes

In interactive switch handling:

```text
set selected CLI preference
clear target CLI native session for chatKey
mark handoff required for target CLI with reason manual_switch
```

The next user message should start a fresh target CLI session seeded with Agent Bridge handoff context.

### Tests

- Switching Codex -> Claude clears Claude session for the chat.
- Next message to Claude includes handoff context once.
- Following message to Claude does not reinject full handoff context.
- Switching back to Codex repeats the same behavior for Codex.

### Exit Criteria

- Manual provider switch and first-turn seeding are deterministic.

## Phase 8 — Fallback Handoff with Auto-Compact

### Production Changes

In `dispatchInteractiveWithFallback()` or a companion service it calls:

```text
on capacity exhaustion:
  compactConversation(mode: fallback_handoff, pruneOnSuccess: true)
  continue even if compaction fails
  select next CLI
  clear next CLI session
  mark handoff required for next CLI, reason fallback
  replay update into next CLI
```

Add cooldown:

```text
BRIDGE_FALLBACK_COMPACT_COOLDOWN_MS=300000
```

### Tests

- Capacity failure triggers compact before fallback.
- Compact success promotes memories before next CLI turn.
- Compact failure does not block fallback.
- Next CLI receives handoff context once.
- Cooldown prevents repeated compaction loops.

### Exit Criteria

- Fallback and manual switching share the same handoff semantics.

## Phase 9 — Commands and User Visibility

### Production Changes

Review existing `/context` and `/compact` responses.

Recommended additions:

```text
/context
  show latest compact, turn count, un-compacted turn count, pending handoff state

/compact
  report summary stored, turns covered, memory candidates promoted/rejected

/memory search <query>
/memory status
/memory forget <id>
```

If `/memory` commands are too large for this issue, defer them to a follow-up issue but leave `agent-bridge-context --memory-query` intact.

### Tests

- `/context` shows pending handoff state.
- `/compact` reports non-destructive failure.
- `/compact` reports promoted/rejected memory candidate counts.

### Exit Criteria

- Operators can see what the memory system did.

## Phase 10 — Documentation and Cleanup

### Production Changes

- Update `README.md` memory section.
- Update `docs/README.md` document map.
- Update `docs/architecture/companion-runtime.md` to reference handoff behavior.
- Update `docs/architecture/shared-runtime.md` to reference shared compaction/memory seams.
- Remove obsolete extractor docs/env examples.
- Update `AGENTS.md` or `agents.md` to tell coding agents to respect the compact-first memory design.

### Tests

- Search test or lint check confirms no active docs recommend enabling post-turn extractor.
- Search confirms `BRIDGE_MEMORY_EXTRACTOR_ENABLED` is gone unless only mentioned in changelog/removal notes.

### Exit Criteria

- Docs and code describe one architecture.

## Rollout Plan

1. Merge docs/plan PR.
2. Implement Phase 0 tests in a new PR.
3. Implement Phases 1-5 in one PR if manageable.
4. Implement Phases 6-8 in a second PR if the handoff changes become large.
5. Implement Phase 9 commands as follow-up if scope grows.

## Risks

### Risk: Context under-injection after changing to one-time handoff

Mitigation:

- comprehensive tests for first turn, second turn, switch, fallback, compact, and invalid-session retry;
- conservative first implementation can inject on `sessionId === null || handoff_required` before tightening individual-bot behavior.

### Risk: Compact JSON parsing failures

Mitigation:

- strict parser with useful error metadata;
- compaction failure is non-destructive;
- fallback continues with previous summary and raw turns.

### Risk: Automatic memory promotion stores poor memories

Mitigation:

- reuse existing validation;
- add profile-specific prompt constraints;
- log rejected/duplicate/promoted candidates;
- add `/memory forget <id>` follow-up if not included in first PR.

### Risk: Fallback latency increases

Mitigation:

- compact cooldown;
- non-blocking fallback if compaction fails quickly;
- consider compact only when un-compacted turn count exceeds a small threshold.

## Acceptance Criteria

- [ ] Post-turn extractor removed.
- [ ] Compact returns structured summary + memory candidates.
- [ ] Compact profiles implemented and tested.
- [ ] `/compact` and fallback use one compaction service.
- [ ] Compaction failure is non-destructive.
- [ ] Persistent memory candidates are promoted through validation.
- [ ] Handoff context is injected once for fresh interactive provider sessions.
- [ ] Continuing the same provider session does not repeatedly inject full context.
- [ ] Manual switch clears target session and marks handoff required.
- [ ] Fallback compacts, promotes, clears target session, and injects once.
- [ ] Handoff uses latest summary + latest N recent turns.
- [ ] Compaction processes all un-compacted turns, including >200-turn backlogs.
- [ ] Docs no longer recommend the post-turn extractor.
