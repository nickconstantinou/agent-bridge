# 08 — Testing Strategy

Baseline: 73 files / 1,335 tests / vitest / typecheck clean. Strict red-green-refactor per repo CLAUDE.md.

## Layers

| Layer | Location | Runs | Purpose |
|---|---|---|---|
| Acceptance (per epic) | `test/acceptance/<epic>/` | CI, separate step | Epic-level behaviour + structural intent; written BEFORE implementation |
| Integration | `test/*.test.ts` (existing pattern) | CI + pre-commit | Module seams: executor+handlers, engine+adapters, sync jobs (mocked GitHub) |
| Unit | alongside | CI + pre-commit | Pure logic |
| Characterization | tagged `@characterization` | CI | Lock current behaviour before strangler refactors (Epic 2 arg builders/parsers, Epic 4 db methods) |
| Architectural lint | `scripts/arch-lint.sh` | pre-commit + worker acceptance | Intent enforcement (ADR-007) |

## arch-lint rules (initial set)

```bash
# 1. no test harness in production
rg -l "from ['\"]vitest|VITEST_WORKER_ID" src/ && fail
# 2. SQL only in repositories/db
rg -l "\.prepare\(" src/ --glob '!src/repositories/**' --glob '!src/db.ts' --glob '!src/db/**' && fail
# 3. layering: providers never import messaging; workflows never import providers directly
rg -l "from ['\"]\.\./telegram|from ['\"]\.\./discord" src/providers/ && fail
rg -l "from ['\"]\.\./providers/" src/workflows/ && fail
# 4. no duplicated bots config (entry points must import src/config)
rg -l "modelPreference: parseModelPreference" src/index*.ts && fail   # after Epic 1
```

## Per-epic acceptance-first protocol
1. Write acceptance tests (red) — behavioural + structural.
2. Characterization tests for any code being moved (green, locking).
3. Implement smallest change; suite green.
4. Refactor; suite green; arch-lint green.
5. Regression tests for every defect found en route (e.g. G6 "session not found must not fallback").

## Golden tests
- Workflow migration (Epic 5): tdd_implementation output via legacy handler vs workflow engine must be byte-identical on fixture jobs.
- Rendering migration (Epic 3): fixture markdown corpus → IR renderer output snapshots for worker surface.

## Consistency property tests
- Epic 6: for seeded random event sequences, reducer state == column state.
- Epic 8: table-driven fallback walks (429 / model-missing / auth / transient) → exact expected chain.

## Worker-bot integration of this strategy
- Acceptance-criteria templates (implementationPlan handler) must include at least one structural assertion for architecture/refactor task types.
- arch-lint added to tdd handler's gate alongside existing TEST_ONLY_SOURCE_PATTERN check (handlers/tddImplementation.ts:14).
- Repair jobs triggered by acceptance failure carry the failing assertion text as context.
