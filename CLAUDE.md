# Development Practice — Red-Green-Refactor TDD

**All implementation work uses red-green-refactor TDD. No exceptions.**

1. **Red** — write a failing test that describes the desired behaviour before touching production code.
2. **Green** — make the smallest change that passes the test.
3. **Refactor** — clean up with tests green.

By work type:
- **Feature:** write the first acceptance or unit test before implementation.
- **Bug fix:** reproduce with a failing regression test before fixing.
- **Refactor:** add characterization tests that lock existing behaviour before restructuring.

Run `npm test` for the full suite. Report: red test → green change → suite result.

---

# Persistent memory

You have access to a local memory CLI named `agent-memory`.

Use it when the task depends on previous project decisions, architecture, bugs, conventions, commands, or unresolved TODOs.

Before making architectural decisions or modifying important behaviour, run:

```bash
agent-memory recall --query "<short relevant query>" --scope project --limit 10
```

When you learn a durable project fact, decision, bug fix, convention, or recurring issue, save it:

```bash
agent-memory add --type decision --scope project --text "<concise memory>"
```

Do not save secrets, API keys, passwords, transient logs, or private personal information.
Do not rely on MCP for memory.

---

# Health Monitoring System

**Active** — enabled via `HEALTH_MONITOR_ENABLED=true` in `.env.shared` or `.env.health`.

A `HealthScheduler` runs alongside the bots and fires registered `HealthPlugin` instances on a `setInterval`. Key facts for working on this codebase:

- **`src/health/`** — types, reporter, scheduler, suggest, plugins/self, plugins/server, plugins/external
- **`SelfPlugin`** — always registered; checks DB file + read liveness
- **`ServerPlugin`** — checks CPU load, RAM/Swap, zombie processes, system uptime, and security posture (UFW status, SSH key permissions, environment file permissions)
- **`ExternalPlugin`** — spawns any shell command asynchronously with a timeout, parses stdout as `HealthReport` JSON
- **`generateSuggestion`** (suggest mode) — routes through `buildCliInvocation → runCli → parseCliResult`, same path as real user messages. Bot selected by `HEALTH_SUGGEST_BOT` env var. Filters error-shaped responses.
- **`_suggestFn` injection** — `HealthScheduler` constructor accepts `_suggestFn` to replace `generateSuggestion` in tests, avoiding real CLI spawning under fake timers
- **Content-crawler POC** — `~/content-crawler/scripts/health_check.py`; checks queue depth, failed items, stale workers, signal-feed age, disk space; enabled via `HEALTH_CONTENT_CRAWLER_ENABLED=1`

When modifying the health module, keep `_suggestFn` injectable — do not inline `generateSuggestion` in the scheduler.
