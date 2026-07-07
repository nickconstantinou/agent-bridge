# Issue #69 Acceptance Checklist

Use this checklist during the implementation PR review.

## Extractor Removal

- [ ] `src/memoryExtractor.ts` deleted.
- [ ] `BRIDGE_MEMORY_EXTRACTOR_ENABLED` removed from active docs and runtime config.
- [ ] `BridgeEngine` no longer calls a post-turn extractor after successful responses.
- [ ] Normal successful turns do not perform a second model/CLI call for memory extraction.

## Compaction

- [ ] Compaction returns structured output: `summary_md` and `memory_candidates`.
- [ ] `summary_md` is stored only when valid and non-empty.
- [ ] Memory candidates are promoted only through validation.
- [ ] Duplicate/rejected memory candidates do not fail compaction.
- [ ] Companion and engineering profiles are implemented.
- [ ] `/compact` and fallback share the same compaction service.
- [ ] Failed compaction is non-destructive.
- [ ] Raw turns are pruned only after a useful summary is stored successfully.

## Recent Turns

- [ ] Handoff context uses latest summary + latest N turns.
- [ ] More than 200 turns after latest summary does not omit the newest turns.
- [ ] Compaction processes all un-compacted turns, regardless of prompt-context limits.

## Handoff

- [ ] Handoff state exists per chat/thread and CLI.
- [ ] Manual switch clears the target CLI session and marks handoff required.
- [ ] Fallback clears the next CLI session and marks handoff required.
- [ ] Handoff context is injected once into a fresh target CLI session.
- [ ] Continuing the same CLI session does not reinject the full handoff context.
- [ ] Invalid native session retry can seed context once without double injection.

## Fallback

- [ ] Fallback attempts compaction before switching provider.
- [ ] Fallback continues even if compaction fails.
- [ ] Fallback has compaction cooldown or equivalent loop protection.
- [ ] Current user update is replayed into the next CLI after handoff state is prepared.

## Docs

- [ ] `README.md` and docs are aligned with compact-first memory.
- [ ] No active docs recommend post-turn extractor usage.
- [ ] Architecture docs and implementation plan agree.
