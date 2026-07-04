# July 2026 Documentation Status Corrections

Validated against: `main` after PR #45.

This document records status corrections that should be applied before broader file moves. It exists because some long-form docs contain prompt-wrapper examples or large historical sections that are safer to edit from a local checkout than through the chat connector's full-file replacement API.

## Corrections to apply

### `docs/soul.md`

Current classification: `runtime-design`, implemented.

Correction:

- Change the title from `SOUL.md Design` to `SOUL.md Runtime Design`.
- Change language from “proposed bridge-level persona contract” to “implemented bridge-level persona contract”.
- State explicitly that `src/soul.ts` implements loading and compaction.
- State explicitly that runtime default is root `SOUL.md`, unless `AGENT_BRIDGE_SOUL_PATH` points elsewhere.
- Do not archive this file.

Reason:

`src/soul.ts`, `src/index.ts`, `src/index-health.ts`, and `src/cli.ts` ground this as implemented runtime behavior, not speculative research.

### `docs/native-telegram-layout-spike.md`

Current classification: partially implemented / partially superseded.

Correction:

- Replace the opening status that says rich-message paths were retired.
- State that production delivery currently uses entity-rendered `sendMessage` as the baseline.
- State that document fallback remains opt-in.
- State that table responses still have an opportunistic rich-message route when the client supports `sendRichMessage`, with fallback to entity messages.

Reason:

`src/messageDelivery.ts` still checks for table routes and attempts `sendRichMessage` before falling back to entity delivery.

### `docs/prompt-optimization-loop-research.md`

Current classification: implemented-record with stale notes.

Correction:

- Add status/front matter marking it as an implementation record.
- Mark the old `src/agentMemory.ts` discussion as historical/stale.
- Keep the optimizer methodology because `AGENTS.md` references it.
- Do not use it as an active runtime roadmap.

### `docs/PRD.md`

Current classification: product reference, partially superseded by architecture docs.

Correction:

- Add status/front matter marking it as advisory product reference.
- State that ADRs and `docs/architecture/` override it on conflicts.
- State that `docs/roadmap/epic-11-runtime-hardening.md` is the active Epic 11 implementation source.

### `docs/WORKER-GUIDE.md`

Current classification: authoritative operations.

Correction:

- Add status/front matter marking it as canonical worker operator documentation.
- Remove or update stale phase references once maintainer queue triage has a current roadmap.

### `docs/SAFE-RESTART.md`

Current classification: authoritative operations.

Correction:

- Add status/front matter marking it as canonical restart safety documentation.
- Keep it in place because `AGENTS.md` encodes the same restart safety rule.

## Local checkout command sequence

Use a local checkout for the exact edits:

```bash
git checkout -b docs/status-frontmatter
npm test -- --runInBand 2>/dev/null || true
```

Then edit the docs above, run markdown/lint checks if available, and open a docs-only PR.

## Guardrail

Do not move root research files until these corrections are applied and inbound references are updated.
