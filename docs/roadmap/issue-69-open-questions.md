# Issue #69 Open Questions

## 1. Should normal `/compact` use the fallback compact path?

Recommendation: yes.

Use one shared compaction service for manual `/compact`, fallback handoff, switch handoff, and future scheduled compaction.

Reasoning:

- one path is easier to test and reason about;
- fallback needs non-destructive compaction failure semantics;
- normal `/compact` benefits from the same safety rule;
- weak tombstones should not replace useful summaries or justify pruning raw turns.

Decision to implement unless contradicted by a later ADR:

```text
compact succeeds -> store summary, promote memories, prune covered turns when requested
compact fails    -> do not store replacement summary, do not prune, keep previous context usable
```

## 2. What should happen when more than 200 turns exist after the latest summary?

Recommendation: split retrieval paths.

Prompt/handoff context should use:

```text
latest compact summary + latest N turns after that summary
```

Compaction should use:

```text
all turns after the latest summary, chunked as needed
```

The prompt/handoff recent-turn limit must never cause newest turns to be omitted.

The compaction backlog must never depend on the prompt-context limit.

## 3. Should memory promotion be automatic or reviewed?

Current issue #69 direction: automatic promotion from compaction, but only after validation through `storeProjectMemoryCandidate()`.

Possible follow-up:

- add `/memory review` if automatic promotion proves noisy;
- add `/memory forget <id>` for operator/user correction.

## 4. Should individual bots get one-time handoff context?

Recommendation:

- individual bots may rely primarily on native CLI session continuity;
- inject Agent Bridge context only when no native session exists, after `/compact`, or after invalid-session retry;
- interactive/companion bot must use one-time handoff context for provider switching/fallback.
