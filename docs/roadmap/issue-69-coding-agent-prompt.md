# Coding Agent Prompt: Issue #69 Compact Memory and Handoff

Use this prompt for the implementation PR after the documentation PR lands.

```text
You are implementing Agent Bridge issue #69 in `nickconstantinou/agent-bridge`.

Read these documents first and treat them as source of truth:

1. `docs/architecture/memory-and-handoff.md`
2. `docs/roadmap/issue-69-compact-memory-handoff.md`
3. `docs/roadmap/issue-69-change-impact.md`
4. `docs/architecture/companion-runtime.md`
5. `docs/architecture/shared-runtime-memory-handoff-note.md`
6. `docs/README.md`

Goal:

Replace the post-turn memory extractor with compact-first memory promotion and one-time provider handoff context.

Required behavior:

- Remove the post-turn extractor completely.
- Make compaction the single automatic durable-memory distillation path.
- Have compaction produce structured `{ summary_md, memory_candidates }` output.
- Store `summary_md` in `conversation_summaries`.
- Promote validated `memory_candidates` to `project_memories` using the existing candidate validation path.
- Add companion and engineering compact profiles.
- Use one shared compaction service for `/compact`, fallback handoff, and switch handoff.
- Make compaction failure non-destructive: do not prune raw turns or replace useful summaries with tombstones.
- In the interactive/companion bot, inject Agent Bridge handoff context only on the first turn of a fresh provider session.
- After first successful target CLI response, rely on the native CLI session ID for continuity.
- Manual provider switch and fallback must share the same handoff method.
- Fallback should attempt compaction first, promote memory candidates if compaction succeeds, then replay the current user update into the next CLI.
- Fallback must continue even if compaction fails.
- Handoff context must use latest compact summary + latest N turns, not the first N turns after the summary.
- Compaction must process all un-compacted turns via chunking, including more than 200 turns since the latest summary.

TDD requirements:

Start with failing tests for:

1. post-turn extractor no longer runs after a normal turn;
2. `/compact` stores summary and promotes memory candidates;
3. compact failure leaves raw turns and previous summaries intact;
4. companion compact profile captures non-engineering durable facts;
5. engineering compact profile preserves repo/PR/file/test details;
6. more than 200 turns since latest summary still injects newest turns in handoff context;
7. compaction processes the full un-compacted backlog;
8. manual CLI switch clears target session and injects handoff context once;
9. fallback attempts compaction, continues on compact failure, and injects handoff context once;
10. continuing the same CLI session does not reinject full Agent Bridge context.

Do not introduce vector DBs, embeddings, cross-repo memory routing, broad runtime renames, or a large worker rewrite.

Keep the implementation incremental and preserve existing public commands unless this issue explicitly changes them.
```
