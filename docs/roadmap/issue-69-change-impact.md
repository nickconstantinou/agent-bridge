# Issue #69 Change Impact Analysis

## Runtime Behavior to Change

### Remove

- Per-turn durable-memory extraction after assistant responses.
- `BRIDGE_MEMORY_EXTRACTOR_ENABLED` as an active runtime feature.
- Any tests or docs that present post-turn extraction as the preferred memory path.

### Add

- Structured compaction output with `summary_md` and `memory_candidates`.
- Automatic promotion of validated compact memory candidates into `project_memories`.
- Companion and engineering compact profiles.
- One-time handoff context injection for fresh interactive provider sessions.
- Shared handoff behavior for manual switch and fallback.
- Latest-N recent-turn retrieval for handoff context.
- Full-backlog chunked compaction independent of prompt-context limits.

## Code Areas Likely to Change

### `src/engine.ts`

- Remove `_extractPostTurnMemories()`.
- Remove post-turn extraction calls in sync and async execution paths.
- Add one-time handoff context behavior.
- Ensure `/compact` delegates to shared compaction service.
- Ensure successful first handoff response clears handoff state.

### `src/compactSummary.ts`

- Replace markdown-only compact prompt with structured compact output.
- Add compact profiles.
- Add parser for compact result.
- Keep chunk/reduce helpers or move them into a service module.

### New compact service module

Suggested name:

```text
src/compactConversation.ts
```

Responsibilities:

- summarise all un-compacted turns;
- merge with previous summary;
- store summary on success;
- promote memory candidates;
- prune only after summary storage succeeds;
- return structured result metadata.

### `src/db.ts`

- Add latest-N retrieval for handoff context.
- Keep all-turn retrieval for compaction.
- Add handoff state helpers or use settings helpers.
- Add un-compacted turn count helper.

### `src/interactiveBot.ts`

- On fallback, call compact service first.
- Set handoff-required state for target CLI.
- Clear target CLI session before replay.
- Apply cooldown for fallback compaction.

### `src/index-interactive.ts`

- On manual switch, clear target CLI session and mark handoff required.
- Keep preference and command-registration behavior.

### `src/projectMemory.ts`

- Reuse existing candidate validation.
- Consider adding source metadata for compact promotion mode.

### `src/contextCommand.ts`

- Keep memory search affordances.
- Consider adding status output for handoff state and memory count.

## Test Impact

Minimum new/updated tests:

1. post-turn extractor does not exist/run;
2. compact success stores summary and promotes memory candidates;
3. compact failure is non-destructive;
4. companion profile handles non-engineering context;
5. engineering profile preserves repo/PR/test details;
6. handoff context uses latest N turns;
7. compaction processes all turns beyond 200;
8. manual switch injects handoff once;
9. fallback compact failure still falls back;
10. continuing same CLI session does not reinject full context.

## Documentation Impact

Documentation should consistently describe:

- compact-first memory;
- persistent memory promotion from compaction;
- post-turn extractor removed;
- one-time provider handoff context;
- latest-N handoff context and full-backlog compaction.
