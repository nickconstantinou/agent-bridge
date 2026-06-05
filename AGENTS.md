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

# Health bot conventions

- The dedicated health service runs through `src/index-health.ts` with `BridgeEngine` kind `health`, but its suggestion CLI must execute through the configured agent kind (`HEALTH_SUGGEST_BOT` / `HEALTH_CLI_BOT`) so invocation, parsing, timeouts, and Telegram rendering match Codex, Antigravity, or Claude behavior.
- Manual `/health` should return one combined report only. Persist plugin reports for `/status` context with `HealthBridgeBot.handleReport(..., { force: true, silent: true })`; do not also force-send each plugin report.
- `HEALTH_SUGGEST_*` is the documented health suggestion config family. `HEALTH_CLI_*` remains a compatibility alias.
