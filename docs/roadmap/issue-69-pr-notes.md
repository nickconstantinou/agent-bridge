# PR Notes: Issue #69 Compact Memory and Handoff

## Purpose

This documentation PR records the intended architecture and implementation plan before code changes begin.

It does not implement issue #69. It creates the source-of-truth docs that future implementation PRs should follow.

## Documents Added

- `docs/architecture/memory-and-handoff.md`
  - canonical compact-first memory and CLI handoff architecture;
  - removes post-turn extractor as intended design;
  - defines compact summary + persistent memory candidate promotion;
  - defines one-time handoff context for manual switch and fallback;
  - defines the corrected recent-turn policy for more than 200 turns.

- `docs/roadmap/issue-69-compact-memory-handoff.md`
  - TDD implementation plan;
  - affected files;
  - phased implementation slices;
  - acceptance criteria;
  - risks and mitigations.

## Documents Updated

- `docs/README.md`
  - indexes the new architecture and roadmap docs;
  - points historical memory research to the new canonical architecture.

- `docs/architecture/companion-runtime.md`
  - clarifies the Companion Runtime provider handoff behavior;
  - points to the canonical compact memory and handoff design.

## Implementation Follow-up

Recommended next implementation PR sequence:

1. Characterisation tests for issue #69.
2. Remove post-turn extractor.
3. Add structured compact output and profile prompts.
4. Extract shared compact service.
5. Fix latest-N recent-turn retrieval.
6. Add one-time handoff state and prompt injection.
7. Wire manual switch and fallback to the shared handoff path.
8. Update user/operator docs and memory command surface.

## Known Note

An attempted update to `docs/architecture/shared-runtime.md` was blocked by the connector safety layer. The added canonical architecture document still defines the shared compaction and handoff service boundary. A follow-up implementation PR can update `shared-runtime.md` locally if needed.
