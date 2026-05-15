# Shared Memory

`agent-bridge` now uses a local shell-callable CLI, `agent-memory`, instead of MCP on the critical path.

## Database

Default SQLite path:

```bash
$HOME/.agent-bridge/shared-memory/agent-memory.sqlite
```

Override with:

```bash
AGENT_MEMORY_DB_PATH=/absolute/path/to/agent-memory.sqlite
```

## Commands

```bash
agent-memory add --type decision --scope project --text "..."
agent-memory recall --query "..." --scope project --limit 10 --json
agent-memory search --query "..." --scope project --limit 10 --json
agent-memory list --scope project --json
agent-memory update --id mem_123 --text "..."
agent-memory delete --id mem_123
```

## Backup

Back up the SQLite file directly, or copy the whole directory:

```bash
cp ~/.agent-bridge/shared-memory/agent-memory.sqlite /backup/
```

## Agent usage

- Query before architectural or behavior changes.
- Store durable project facts, bug fixes, decisions, and conventions.
- Do not store secrets or transient chat noise.
- MCP is optional, but not required for memory.
