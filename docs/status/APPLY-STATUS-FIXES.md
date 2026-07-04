# Apply Status Fixes Locally

The chat GitHub connector can only replace full files. Some docs contain long prompt examples or large historical sections, so exact source edits are safer from a local checkout.

## Checklist

- [ ] Update `docs/soul.md` to say SOUL is implemented runtime design.
- [ ] Update `docs/native-telegram-layout-spike.md` to reflect current table/rich-message behavior.
- [ ] Mark stale `src/agentMemory.ts` references in `docs/prompt-optimization-loop-research.md` as historical.
- [ ] Add front matter to `docs/PRD.md`.
- [ ] Add front matter to `docs/WORKER-GUIDE.md`.

## Required verification

Docs-only edits should still run the available repo checks from a local checkout when practical:

```bash
npm run typecheck
npm test
```

If no implementation files changed, test failures should be treated as environmental or pre-existing unless the docs tooling reports otherwise.
