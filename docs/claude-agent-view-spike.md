# Claude Agent View — Spike Research

Date: 2026-05-29
Status: spike complete, no implementation changes required now
Owner: Agent Bridge

## Context

Claude Code v2.1.139+ ships an "agent view" feature (`claude agents`) that manages multiple
background sessions from a single TUI. This spike investigated whether adopting background
session dispatch would improve bridge behaviour over the current foreground blocking model.

## What agent view provides

`claude agents` opens a TUI showing every background session as a row with live state
(working / waiting on you / done), a peek panel for latest output, and inline reply without
leaving the view. Each background session is a full Claude Code conversation that keeps
running detached from any terminal.

## Spike findings

### `claude agents --json` — stable scripting interface

The `--json` flag exits immediately with a JSON array of all live sessions. No TUI scraping
required.

```json
[
  {
    "pid": 860485,
    "cwd": "/home/openclaw/.openclaw/workspace",
    "kind": "background",
    "startedAt": 1780055141969,
    "sessionId": "19377a3e-1e0f-47e0-8273-696111ca4c70",
    "name": "optional display name"
  }
]
```

Fields: `pid`, `cwd`, `kind` (`"background"` | `"interactive"`), `startedAt` (epoch ms),
`sessionId` (UUID), `name` (optional).

### Background dispatch

`claude --print --bg "<prompt>"` starts a background session and prints a short session ID
to stdout. The ID is reliably parseable:

```bash
$ claude --print --bg "your task"
Starting background service…
backgrounded · ecc76a74
  claude agents             list sessions
  claude attach ecc76a74    open in this terminal
  claude logs ecc76a74      show recent output
  claude stop ecc76a74      stop this session
```

Extract: `grep -oP 'backgrounded · \K[a-f0-9-]+'`

### Critical gap: no post-hoc output retrieval

`claude logs <id>` reads via a Unix socket at `/tmp/cc-daemon-<uid>/<hash>/control.sock`.
Once the session process exits:

- The socket is removed immediately
- The session drops off `claude agents --json`
- `claude logs` returns: `job not found — it may have already exited`

There is no persistent log file or output store accessible after process exit.

## Verdict

The background model is viable but does **not** simplify the bridge — it adds complexity
with no net gain for the single-user Telegram use case.

To relay output from a background session you must stream `claude logs <id>` continuously
from dispatch time and detect completion by socket disappearance. That is the same job as
the current blocking `runCli` loop, with an extra process boundary and a race condition if
the socket vanishes mid-stream.

**The current foreground blocking model remains the right default.** It streams, captures
everything, and is proven.

## When background sessions would be an improvement

Background dispatch is worth adding as an **opt-in mode**, not a replacement, for:

- Tasks expected to run longer than ~2 minutes
- Parallel workloads (user fires multiple independent tasks without waiting)
- Cases where the user explicitly wants to check back rather than wait

Proposed UX: a `/bg` prefix in the Telegram message triggers background dispatch. The
bridge streams `claude logs <short-id>` and relays chunks to Telegram in real time. The
user can send follow-up messages addressed to that session. All other messages continue
using the existing foreground path.

## Implementation notes (if /bg mode is built later)

- Parse short session ID from `--bg` stdout (regex above)
- Retrieve full UUID from `claude agents --json` by matching short prefix
- Pipe `claude logs <id>` stdout → Telegram edit loop (same pattern as current streaming)
- Detect completion: socket gone → `claude logs` exits with error → mark session done
- Store `(chatId, shortId, fullSessionId, status)` in a new `background_sessions` table
- `/sessions` command lists active background sessions per chat

## Claude Code version tested

v2.1.145 (confirmed: `claude --version`)
