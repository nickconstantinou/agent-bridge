---
status: active-roadmap
type: roadmap
authority: canonical
implementation_status: partially-implemented
last_validated_against: issue-69
---

# Issue #69 Implementation Plan: Compact Memory and CLI Handoff

## Implementation Status

PRs 1-6, 6.1, and 6.2 are merged to `main`. PR 7 is implemented locally, pending PR/review.

| PR | Scope | Status |
|---|---|---|
| 1 | Characterisation tests + post-turn extractor removal | merged (#71) |
| 2 | Structured compact JSON output + companion/engineering profiles | merged (#72) |
| 3 | Shared `compactConversation()` service + memory promotion + non-destructive failure | merged (#73) |
| 4 | Latest-N context retrieval fix (was returning oldest-N, a real bug) | merged (#74) |
| 5 | One-time handoff state primitive (`src/handoffState.ts`), added in isolation | merged (#75) |
| 6 | Wire manual switch + fallback to compaction/handoff state | merged (#76) |
| 6.1 | Configurable context injection policy (`BRIDGE_CONTEXT_INJECTION_POLICY`) — closes the PR 6 scope reduction below | merged |
| 6.2 | Minimal pre-seed compaction (`BRIDGE_PRESEED_COMPACT_MODE`) ahead of a fresh-seed `handoff_once` turn | merged |
| 7 | Operator diagnostics for context/memory health (`/context` only — no `/memory` command) | not yet merged |

**PR 6 scope reduction, resolved by PR 6.1:** PR 6 left context injected on every turn for every CLI kind regardless of session/handoff state (the handoff flag was consumed for audit/logging only). PR 6.1 adds `BRIDGE_CONTEXT_INJECTION_POLICY`:

- `always` (default): unchanged every-turn injection — existing self-hosted OSS deployments see no behavior change.
- `handoff_once` (recommended for platform-managed workspaces, see `docs/architecture/platform-boundary.md`): inject only when there is no native CLI session, a handoff is pending, or `/compact`/invalid-session recovery just reset the session (all three clear the session and retry with `sessionId: null`); otherwise rely on the native session. `AGENT_BRIDGE_CONTEXT_COMMAND` and related env vars remain available under both policies regardless of whether the prompt preamble is injected. The handoff flag is now consumed only on a turn that actually receives injected context — never on a turn the policy (or `/reset`'s `ctx_suppress`) suppresses.

**PR 6.2, minimal pre-seed compaction:** adds `getUncompactedConvStats(chatKey)` (`src/db.ts`) and `BridgeEngine._maybePreseedCompact()` (`src/engine.ts`). Under `handoff_once`, on a turn that will inject full context into a fresh provider session, checks the un-compacted turn/char count first. `BRIDGE_PRESEED_COMPACT_MODE=off` (default) is a no-op — unchanged behavior. `BRIDGE_PRESEED_COMPACT_MODE=auto` compacts via the existing `compactConversation()` service before injection when the char count exceeds `BRIDGE_PRESEED_COMPACT_CHARS` (default `30000`); skipped at zero un-compacted turns or when `compact_in_progress:<chatKey>` is already set; any compaction failure is logged and swallowed, never blocking the turn. Recommended platform defaults: `BRIDGE_CONTEXT_INJECTION_POLICY=handoff_once`, `BRIDGE_PRESEED_COMPACT_MODE=auto`, `BRIDGE_PRESEED_COMPACT_CHARS=30000`. Non-goals for this PR: `/memory` commands, semantic milestone detection, idle/background compaction, tokenizer-based accounting, and changes to memory promotion or compact summary format.

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

## File Impact Summary

### `src/engine.ts`

- Post-turn extraction calls removed from sync/async execution paths (PR 1, done).
- `/compact` handler delegates to the shared `compactConversation()` service instead of inline summarize/store/prune logic (PR 3, done).
- One-time handoff flag consumption wired into `_buildRecentContextPrompt` (PR 6) — logging/audit only; does not yet gate injection (see Implementation Status above).

### `src/compactSummary.ts`

- Structured `{ summary_md, memory_candidates }` JSON output contract, `CompactProfile` (`"engineering" | "companion"`), and `parseCompactOutput()` parser (PR 2, done).
- `chunkCompactTurns`/`buildCompactSummaryPrompt`/`buildCompactReducePrompt` retained; `buildTombstone()` removed once failure became non-destructive (PR 3, done).

### `src/compactConversation.ts` (new module, PR 3, done)

- `compactConversation(chatKey, deps)`: summarise, promote memory candidates through `storeProjectMemoryCandidate()`, prune only on success. Non-destructive on any failure.

### `src/handoffState.ts` (new module, PR 5, done)

- `markHandoffRequired` / `isHandoffRequired` / `clearHandoffRequired` / `consumeHandoffRequired`, keyed by `handoff_required:<chatKey>:<cliKind>` in `settings`.

### `src/fallbackCompactCooldown.ts` (new module, PR 6)

- Rate-limits compact-before-fallback so a cascading multi-hop fallback doesn't trigger a compaction CLI call before every single hop. Default 5 min, override `BRIDGE_FALLBACK_COMPACT_COOLDOWN_MS`.

### `src/db.ts`

- `getRecentConvTurns`'s `sinceId` branch fixed to fetch newest-first (was oldest-first — a real bug that silently dropped the newest messages once a chat crossed the candidate cap) (PR 4, done).
- `getConvTurnsForCompaction` already had no `LIMIT` and processes the full backlog regardless — unaffected, confirmed by existing >1000-turn chunking tests.
- Candidate-fetch cap configurable via `BRIDGE_CONTEXT_RECENT_TURN_LIMIT` (default 200) (PR 4, done).

### `src/interactiveBot.ts`

- `dispatchInteractiveWithFallback` gained `compactBeforeSwitch` dep, cooldown-gated, non-blocking on failure. Target session cleared + handoff marked before advancing the chain (PR 6).
- `applyManualCliSwitchHandoff()` — shared helper for manual switch, also used by fallback via `prepareCliHandoff`.

### `src/index-interactive.ts`, `src/index-discord-interactive.ts`, `src/index-worker.ts`

- Manual `/cli` switch call sites wired to `applyManualCliSwitchHandoff` (PR 6).
- `dispatchInteractiveWithFallback` call sites wired with `compactBeforeSwitch` (companion profile for interactive/discord, engineering profile for worker) (PR 6).

### `src/projectMemory.ts`

- Unchanged. `storeProjectMemoryCandidate()` is reused as-is by both the old sidecar path and the new compaction-promotion path.

### Not yet touched

- `src/contextCommand.ts` — `/context` status and `/memory` command surface improvements are PR 7 scope, not started.

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

Actual PR sequence used (see Implementation Status above for merge state):

1. **PR 1 — Characterisation and Extractor Removal.** Add failing tests for the desired no-post-turn-extractor behavior; remove the extractor code and env flag; keep manual/sidecar memory storage intact. Rationale: reduces memory-system complexity before adding the compact-first path.
2. **PR 2 — Structured Compact Output and Profiles.** Add compact JSON output contract; add companion and engineering profiles; add parser and validation tests; keep current `/compact` command behavior as close as possible except for output parsing and safe failure semantics. Rationale: creates the foundation for memory promotion.
3. **PR 3 — Shared Compaction Service and Memory Promotion.** Extract `compactConversation()` service; promote memory candidates through `storeProjectMemoryCandidate()`; make compaction failure non-destructive; make `/compact` use the shared service. Rationale: creates one compaction path before handoff/fallback starts using it.
4. **PR 4 — Latest-N Context Retrieval.** Split prompt-context retrieval from compaction backlog retrieval; add latest-N turn retrieval; add tests for more than 200 turns after latest summary. Rationale: prevents newest-turn loss before relying on handoff context.
5. **PR 5 — One-Time Handoff State.** Add handoff-required state per chat/thread and CLI, in isolation (not yet wired into any dispatch path). Rationale: this changes runtime behavior and should be isolated from the wiring PR, given this exact code path already produced one duplicate-injection bug.
6. **PR 6 — Manual Switch and Fallback Handoff.** Wire manual switch to clear target session and mark handoff; wire fallback to compact, promote, clear target session, mark handoff, and replay current update; add fallback compact cooldown. Rationale: completes the cross-provider continuity behavior. Scoped down from the original Phase 6-8 vision — see Implementation Status above.
7. **PR 7 — Operator Diagnostics for Context/Memory Health.** Improve `/context` with injection policy, pre-seed compact mode/threshold, uncompacted turn/char counts, and a memory *count*; update architecture docs. Explicit decision: no `/memory` Telegram command. Memory is an agent-facing substrate (subprocess CLIs read it via `agent-bridge-context --memory*`), not a human-facing chat feature — the operator gets health signals via `/context`, never memory contents or mutation. Rationale: can follow after the core behavior is stable; keeps the human-facing surface to diagnostics only.

## Open Follow-Up Questions

Two of the four original open questions are resolved and implemented; two remain open follow-ups.

**Resolved (implemented in PR 3 and PR 4):**

1. *Should normal `/compact` use the fallback compact path?* Yes — one shared `compactConversation()` service is used by manual `/compact` and fallback handoff.
2. *What happens when more than 200 turns exist after the latest summary?* Prompt/handoff context uses the latest N turns (not the first N); compaction always processes the full un-compacted backlog via chunking, independent of the prompt-context cap.

**Still open:**

3. *Should memory promotion be automatic or reviewed?* Current direction: automatic promotion from compaction, but only after validation through `storeProjectMemoryCandidate()`. Decided in PR 7: no Telegram-facing `/memory review` or `/memory forget <id>` — memory stays agent-facing only, consumed via `agent-bridge-context`. If automatic promotion proves noisy, correction happens through that same agent-facing surface (e.g. an agent-invoked forget), not a human Telegram command.
4. *Should individual (non-companion) CLI bots get one-time handoff context too?* Recommendation, not yet implemented: individual bots may rely primarily on native CLI session continuity; inject Agent Bridge context only when no native session exists, after `/compact`, or after invalid-session retry. The interactive/companion bot is the one that must use one-time handoff context for provider switching/fallback — that's PR 6's scope.

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

Use this checklist during implementation PR review. Status reflects `main` plus PR #76 (open for review).

### Extractor Removal

- [x] `src/memoryExtractor.ts` deleted.
- [x] `BRIDGE_MEMORY_EXTRACTOR_ENABLED` removed from active docs and runtime config.
- [x] `BridgeEngine` no longer calls a post-turn extractor after successful responses.
- [x] Normal successful turns do not perform a second model/CLI call for memory extraction.

### Compaction

- [x] Compaction returns structured output: `summary_md` and `memory_candidates`.
- [x] `summary_md` is stored only when valid and non-empty.
- [x] Memory candidates are promoted only through validation.
- [x] Duplicate/rejected memory candidates do not fail compaction.
- [x] Companion and engineering profiles are implemented.
- [x] `/compact` and fallback share the same compaction service (PR #76).
- [x] Failed compaction is non-destructive.
- [x] Raw turns are pruned only after a useful summary is stored successfully.

### Recent Turns

- [x] Handoff context uses latest summary + latest N turns.
- [x] More than 200 turns after latest summary does not omit the newest turns.
- [x] Compaction processes all un-compacted turns, regardless of prompt-context limits.

### Handoff

- [x] Handoff state exists per chat/thread and CLI (`src/handoffState.ts`).
- [x] Manual switch clears the target CLI session and marks handoff required (PR #76).
- [x] Fallback clears the next CLI session and marks handoff required (PR #76).
- [x] Handoff context is injected once into a fresh target CLI session — implemented behind `BRIDGE_CONTEXT_INJECTION_POLICY=handoff_once` (PR 6.1); default `always` preserves every-turn injection for existing self-hosted deployments.
- [x] Continuing the same CLI session does not reinject the full handoff context — same flag, `handoff_once` policy (PR 6.1).
- [x] Invalid native session retry seeds context once without double injection — the retry clears the session and recurses with `sessionId: null`, which `handoff_once` treats as a fresh-session condition (PR 6.1); unaffected under `always`.
- [x] Minimal pre-seed compaction ahead of a fresh-seed `handoff_once` turn, opt-in via `BRIDGE_PRESEED_COMPACT_MODE=auto` and `BRIDGE_PRESEED_COMPACT_CHARS` (PR 6.2); off by default, non-blocking on failure.

### Fallback

- [x] Fallback attempts compaction before switching provider (PR #76).
- [x] Fallback continues even if compaction fails (PR #76).
- [x] Fallback has compaction cooldown (PR #76, `fallbackCompactCooldown.ts`).
- [x] Current user update is replayed into the next CLI after handoff state is prepared (pre-existing recursive dispatch behavior, unchanged).

### Docs

- [x] `README.md` and docs are aligned with compact-first memory.
- [x] No active docs recommend post-turn extractor usage.
- [x] Architecture docs and implementation plan agree (this consolidation).
