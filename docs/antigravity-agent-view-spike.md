# Antigravity (Agy) Agent View — Spike Research

Date: 2026-06-12
Status: spike complete, no implementation changes required now
Owner: Agent Bridge

## Context

Following the spike on Claude Code's "agent view" background dispatch (`claude agents`), this spike investigated whether the Antigravity (`agy`) CLI supports a similar background daemon, session tracking, or background dispatch model, and how conversation resumption works in the `agy` CLI context.

## What Antigravity CLI provides

Unlike Claude Code, the `agy` CLI does not ship with a native background daemon, background queue, or agent view TUI (`claude agents`). It does, however, provide robust conversation persistence and resumption natively.

### Subcommands and Flags comparison

| Feature | Claude Code (`claude`) | Antigravity (`agy`) |
|---|---|---|
| Native Background Flag | `--bg` | ❌ None |
| Session Listing | `agents` | ❌ None |
| Output Logs Retrieval | `logs <session-id>` | ❌ None |
| Resume Session Flag | `--resume <id>` | `--conversation <id>` or `--continue` |

### Conversation Resumption

`agy` supports resuming previous sessions using:
- `--conversation <UUID>`: Resumes a specific conversation by its unique ID.
- `--continue` (short: `-c`): Resumes the most recently active conversation in the workspace.

## Spike findings

### 1. No Background Dispatch or Daemon
Running `agy --bg` or `agy agents` results in flag errors or boots into the interactive shell (as the CLI treats unrecognized subcommands as prompt inputs). There is no native background process/socket manager equivalent to Claude's `/tmp/cc-daemon-<uid>`.

### 2. Conversation Persistence
Every time `agy` executes a prompt (both interactive and non-interactive `--print`), it creates a SQLite database (`.db` or Protobuf `.pb`) file named after the conversation UUID under:
`~/.gemini/antigravity-cli/conversations/<UUID>.db`

This database is persisted permanently and does not get cleaned up immediately after CLI process exit, solving the post-hoc retrieval gap observed in Claude Code.

### 3. Conversation ID Extraction
Unlike Claude Code, `agy --print` writes *only* the assistant's output to `stdout` and does not print the newly created conversation UUID. To extract the conversation ID, the bridge must:
- Specify a custom log file using the `--log-file <path>` flag.
- Parse the generated log file for the pattern:
  `Created conversation ([a-f0-9-]{36})` or `Print mode: conversation=([a-f0-9-]{36})`

Example log output:
```text
I0612 18:56:55.750346 2248537 server.go:753] Created conversation 471da29a-fb18-4e60-91e6-fa00da69f052
```

## Verdict

The `agy` CLI lacks a native background dispatcher, but background execution is easily achievable by wrapping the CLI process:
1. **Background execution**: Spawn `agy --print "<prompt>" --log-file <unique-log-path>` as a background process (`&` or Node process spawn).
2. **Session Identification**: Read the custom log file to extract the conversation UUID.
3. **Session Continuations**: Future turns can target the same session using `agy --conversation <UUID>`.
4. **Post-hoc Retrieval**: Unlike Claude Code, conversation database files are persisted permanently at `~/.gemini/antigravity-cli/conversations/<UUID>.db`, meaning there is no risk of losing history when the process terminates.

The foreground blocking execution model remains the default for standard bridge interactions, but background sessions can be implemented via standard Unix/Node process backgrounding if required.

## Antigravity CLI version tested

v1.0.7 (confirmed: `agy --version`)
