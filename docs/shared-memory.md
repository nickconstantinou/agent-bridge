# Shared MCP Memory

`agent-bridge` can configure a shared MCP memory provider for:

- Codex CLI
- Gemini CLI
- Claude Code

The current default provider is `knowledgegraph-mcp` with SQLite storage. This is intentionally kept separate from the bridge's own runtime SQLite database so the memory provider can be swapped later without changing Telegram bridge behavior.

## Default storage

```bash
$HOME/.agent-bridge/shared-memory/knowledgegraph.sqlite
```

Override with:

```bash
SHARED_MEMORY_DB_PATH=/absolute/path/to/knowledgegraph.sqlite
```

## Setup

```bash
npm run setup:shared-memory
```

Run this as the target user. Do not run it with `sudo`.

## Verify

```bash
npm run verify:shared-memory
```

## Files managed

- `~/.codex/config.toml`
- `~/.gemini/settings.json`
- `~/.claude.json`
- `~/AGENTS.md`
- `~/GEMINI.md`
- `~/CLAUDE.md`

The markdown instruction files receive a managed shared-memory block bounded by:

```md
<!-- agent-bridge:shared-memory:start -->
...
<!-- agent-bridge:shared-memory:end -->
```

This lets the installer update the memory handshake rules later without overwriting the rest of the file.

## Memory handshake prompt

```text
On startup, check shared memory for relevant project facts and prior architectural decisions.
Record durable project facts as entities, relations, or observations.
Do not store ephemeral chat noise, tentative brainstorming, or repeated status updates.
Prefer updating existing entities over creating duplicates.
```

## Design constraints

- The bridge runtime database and MCP memory database are separate.
- Config patching is idempotent.
- The implementation is provider-based so `knowledgegraph-mcp` can be replaced later.
- Systemd installation is root-scoped, but shared-memory configuration is user-scoped.
