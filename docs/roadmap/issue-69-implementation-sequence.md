# Issue #69 Implementation Sequence

Recommended PR sequence after this documentation PR.

## PR 1 — Characterisation and Extractor Removal

Scope:

- Add failing tests for the desired no-post-turn-extractor behavior.
- Remove the extractor code and env flag.
- Keep manual/sidecar memory storage intact.

Rationale:

This reduces memory-system complexity before adding the compact-first path.

## PR 2 — Structured Compact Output and Profiles

Scope:

- Add compact JSON output contract.
- Add companion and engineering profiles.
- Add parser and validation tests.
- Keep current `/compact` command behavior as close as possible except for output parsing and safe failure semantics.

Rationale:

This creates the foundation for memory promotion.

## PR 3 — Shared Compaction Service and Memory Promotion

Scope:

- Extract `compactConversation()` service.
- Promote memory candidates through `storeProjectMemoryCandidate()`.
- Make compaction failure non-destructive.
- Make `/compact` use the shared service.

Rationale:

This creates one compaction path before handoff/fallback starts using it.

## PR 4 — Latest-N Context Retrieval

Scope:

- Split prompt-context retrieval from compaction backlog retrieval.
- Add latest-N turn retrieval.
- Add tests for more than 200 turns after latest summary.

Rationale:

This prevents newest-turn loss before relying on handoff context.

## PR 5 — One-Time Handoff State

Scope:

- Add handoff-required state per chat/thread and CLI.
- Inject Agent Bridge handoff context only when required or when starting a fresh session by policy.
- Clear handoff after first successful target response.

Rationale:

This changes runtime behavior and should be isolated.

## PR 6 — Manual Switch and Fallback Handoff

Scope:

- Wire manual switch to clear target session and mark handoff.
- Wire fallback to compact, promote, clear target session, mark handoff, and replay current update.
- Add fallback compact cooldown.

Rationale:

This completes the cross-provider continuity behavior.

## PR 7 — Operator Visibility and Memory Commands

Scope:

- Improve `/context` status.
- Add or update `/memory` commands if accepted.
- Update user-facing docs.

Rationale:

This can follow after the core behavior is stable.
