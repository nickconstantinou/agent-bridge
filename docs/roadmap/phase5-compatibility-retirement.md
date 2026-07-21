# Phase 5 — Compatibility-retirement Slice 0

Status: **inventory and metadata-only instrumentation prepared; no compatibility behavior has been removed.** This plan follows the completed Phase 4 migration-ownership and production-deployment work in Issue #135. The successor tracking issue is [#185](https://github.com/nickconstantinou/agent-bridge/issues/185).

## Goal and constraints

Phase 5 retires compatibility paths only after usage evidence, managed-deployment inventory, a documented deprecation window, rollback review and explicit approval. Repository-internal search is not sufficient to prove that an environment variable, export or parser is unused by external Agent Bridge consumers.

Slice 0 is limited to:

- documenting candidates and their owners/callers;
- inventorying installer, examples and managed systemd configuration by key name only;
- adding startup diagnostics that report alias names and selected/shadowed state only.

It does not remove aliases, change precedence, rewrite configuration, restart services or deploy a production change.

## Diagnostic contract

`src/compatibilityDiagnostics.ts` emits one JSON metadata line per service only when a compatibility alias is present:

```text
[compatibility] {"surface":"...","aliases":[{"alias":"...","canonical":"...","state":"selected|shadowed"}]}
```

Values are never emitted. This includes tokens, user IDs, paths, commands, model names and chain contents. `selected` means the alias is present and its canonical replacement is absent; `shadowed` means both are present. The diagnostic does not alter configuration resolution.

## Candidate matrix

| Candidate | Owner and callers | External/API surface | Managed configuration inventory | Diagnostic | Proposed deprecation window | Rollback | Removal evidence gate |
|---|---|---|---|---|---|---|---|
| `WORKER_CLI_CHAIN` | `src/workerCliPolicy.ts`; worker startup and interactive fallback in `src/index-worker.ts` / `src/index-interactive.ts` | Yes — documented environment configuration; external deployments may use it | Present in `/etc/default/agent-bridge-worker-bot`; documented in `.env.worker.example`; absent from interactive managed defaults | Alias presence and selected/shadowed state; policy decision still required because the worker owns this key directly | Proposed: 30 days and at least two observed weekly inventory windows after a replacement policy is published | Restore the key in the worker environment and restart only through an approved deployment change | Zero managed uses, no reported external use, replacement documented, warning window complete, rollback tested |
| `TELEGRAM_ALLOWED_USER_ID` | Inline authorization parsing in `src/index.ts`, `src/index-worker.ts`, `src/index-interactive.ts`; normalization in `scripts/install.sh` | Yes — public installer/configuration compatibility surface; value is sensitive | Absent from managed `/etc/default` files; present in legacy `.env.gemini`; installer still reads and normalizes it | Alias presence and selected/shadowed state; never the ID value | Proposed: 30 days and two inventory windows | Restore the singular key or set plural `TELEGRAM_ALLOWED_USER_IDS`, then restart through approved deployment | No managed or reported external uses, installer migration guidance complete, authorization behavior regression-tested |
| `HEALTH_CLI_BOT` | `src/health/config.ts` → `src/index-health.ts`; installer/systemd health environment | Yes — documented health-bot configuration surface | Present in `/etc/default/agent-bridge-health`; documented in `.env.health.example`; canonical replacement is `HEALTH_SUGGEST_BOT` | Alias presence and selected/shadowed state | Proposed: 30 days and two inventory windows | Restore `HEALTH_CLI_BOT` or set `HEALTH_SUGGEST_BOT`, then restart the health service through approved deployment | Managed config migrated, no external-use reports, health startup and execution checks green |
| `HEALTH_CLI_COMMAND` | `src/health/config.ts` → `src/index-health.ts`; installer/systemd health environment | Yes — documented health-bot configuration surface | Present in `/etc/default/agent-bridge-health`; documented in `.env.health.example`; canonical replacement is `HEALTH_SUGGEST_COMMAND` | Alias presence and selected/shadowed state; command value never logged | Proposed: 30 days and two inventory windows | Restore the alias or set canonical key, then restart the health service through approved deployment | Managed config migrated, no external-use reports, command invocation and startup checks green |
| `HEALTH_CLI_MODEL_PREFERENCE` | `src/health/config.ts` → `src/index-health.ts` | Yes — documented health-bot configuration surface | Documented in `.env.health.example`; not present in the current managed health defaults | Alias presence and selected/shadowed state; model value never logged | Proposed: 30 days and two inventory windows | Restore alias or set `HEALTH_SUGGEST_MODEL_PREFERENCE` | No managed/external uses, model-selection regression and rollback check green |
| `GEMINI_COMMAND` | `src/config.ts` bot config; `src/bridge.ts` project/provider compatibility paths | Yes — documented legacy provider configuration surface | Not present in current managed defaults; legacy `.env.gemini` contains related `GEMINI_*` settings | Alias presence and selected/shadowed state; command value never logged | Proposed: 60 days and two releases because this is an external provider naming surface | Restore `GEMINI_COMMAND` or set `ANTIGRAVITY_COMMAND`, then restart affected service through approved deployment | Managed inventory clean, external-use evidence reviewed, Antigravity fallback and rollback tested |
| `GEMINI_MODEL_PREFERENCE` | `src/config.ts` bot config | Yes — documented legacy provider configuration surface | Not present in current managed defaults; legacy `.env.gemini` contains it | Alias presence and selected/shadowed state; model value never logged | Proposed: 60 days and two releases | Restore alias or set `ANTIGRAVITY_MODEL_PREFERENCE` | Same as `GEMINI_COMMAND`, plus model-selection evidence |
| `GEMINI_PROJECT_DIR` | `src/config.ts` / `src/bridge.ts` provider project-directory compatibility path | Yes — documented legacy provider configuration surface; path is sensitive | Present in `/etc/default/agent-bridge-worker-bot` and `/etc/default/agent-bridge-interactive`; legacy `.env.gemini` also contains it | Alias presence and selected/shadowed state; path never logged | Proposed: 60 days and two releases; migrate managed paths first | Restore alias or set `ANTIGRAVITY_PROJECT_DIR`, then restart only through approved deployment | Zero managed alias uses, external-use review complete, workspace resolution regression and rollback tested |

### Explicitly not yet a removal candidate

Compatibility exports in `bridge.ts`, `cli.ts` and provider modules, legacy Antigravity parsing, legacy session repair and completed SQLite repair migrations require separate design and child issues. Their usage cannot be established from repository-internal search alone and they are ordered after managed environment aliases.

## Inventory method and current result

The inventory was performed on 21 July 2026 using key names only:

- installer source: `scripts/install.sh`;
- repository examples: `.env.*.example`;
- managed systemd defaults: `/etc/default/agent-bridge-*`;
- runtime consumers: `src/index*.ts`, `src/config.ts`, `src/health/config.ts`, `src/workerCliPolicy.ts`, `src/bridge.ts`.

Current managed findings: `WORKER_CLI_CHAIN` is present for the worker; `HEALTH_CLI_BOT` and `HEALTH_CLI_COMMAND` are present for health; `GEMINI_PROJECT_DIR` is present for worker and interactive; plural `TELEGRAM_ALLOWED_USER_IDS` is used by managed services; the singular Telegram alias is absent from managed defaults. No values were recorded.

## Child-issue order

1. Managed environment aliases: migrate and observe `HEALTH_CLI_*`, `GEMINI_PROJECT_DIR`, `WORKER_CLI_CHAIN` and the installer’s singular Telegram alias.
2. Legacy parser and session-repair behavior: diagnostics and compatibility tests first.
3. Completed SQLite repair migrations: confirm all managed databases and rollback artifacts before any removal.
4. Compatibility exports: last, with an explicit external-consumer review.

Each child issue gets its own PR, diagnostics/evidence period and explicit removal authorization. Slice 0 does not create behavior-removal changes.
