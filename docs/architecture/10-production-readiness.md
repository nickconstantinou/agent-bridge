# 10 — Production Readiness Checklist

Gate for declaring OSS v1.0. Checked per release; automated where possible.

## Architecture
- [ ] All entry points consume `src/config.ts` (structural test green)
- [ ] Provider additions touch only `src/providers/` (mock-provider test green)
- [ ] Zero raw SQL outside repositories/db (arch-lint)
- [ ] Event replay reproduces job state (property test)
- [ ] Platform concepts absent from OSS types (boundary lint)

## Security
- [ ] One Telegram token per surface; startup duplicate detection
- [ ] Secrets via *_FILE indirection, files mode 600; no tokens in repo or logs
- [ ] Child env stripping (buildSafeChildEnv) covers all credential patterns, tested
- [ ] Allowed-user enforcement on every inbound update path (existing) + tests
- [ ] Execution mode "safe" default; "trusted" documented with warnings
- [ ] Dependency audit clean (`npm audit` gate, better-sqlite3/tsx/dotenv only)

## Reliability
- [ ] Circuit breaker, session TTL, orphan cleanup, KillMode=control-group preserved (regression tests)
- [ ] Job resume after restart mid-step (workflow cursor) demonstrated
- [ ] Fallback chain deterministic under 429/exhaustion/model-missing (table tests)
- [ ] Event write failure degrades gracefully (never blocks execution)
- [ ] Worker never blocks on GitHub availability (sync is async)

## Performance
- [ ] Poll loops idle-cheap (no busy loops; getUpdates long-poll)
- [ ] SQLite indices for hot paths (events by job, memories by kind+scope)
- [ ] Large transcript rendering bounded (existing turn text limits) + budgeted memory recall

## Observability
- [ ] Structured logs with runId/jobId correlation
- [ ] /status deep view per job (timeline from events)
- [ ] Health bot: service liveness, queue depth, repair-rate, provider health probes
- [ ] Heartbeat API serving version + service states

## Recovery
- [ ] Documented restore: single SQLite file backup/restore drill performed
- [ ] Orphaned run/job cleanup verified after kill -9 drill
- [ ] Provider auth expiry produces alert, not silent fallback

## Documentation
- [ ] Operator runbook (install, tokens, systemd, backup, recovery drills)
- [ ] Contributor guide: adding a provider (adapter how-to), adding a workflow (declaration how-to)
- [ ] ADRs current; roadmap statuses accurate

## Upgrade path & compatibility
- [ ] Additive-only migrations verified against a copy of production DB
- [ ] `upgrade.sh` uses install@latest pattern (fixed) and restarts via safe-restart flow
- [ ] Config env vars stable for one minor version after deprecation notice

## API stability (v1.0 freeze surface)
- [ ] ProviderAdapter interface
- [ ] WorkflowDefinition schema
- [ ] Event type names/payload required fields
- [ ] Bootstrap + Heartbeat API shapes
