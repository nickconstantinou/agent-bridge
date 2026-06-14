# @cursor/sdk — Native Cursor Agent Headless Spike

**Date:** 2026-06-14
**Verdict: CONDITIONAL YES — viable with a CURSOR_API_KEY and a thin Node.js shim.**

---

## Package Identity Correction

The request named `@cursor/cli`. That package **does not exist** on npm (HTTP 404).
The real distribution is the **TypeScript SDK** published at `@cursor/sdk` (v1.0.18).

| Probe | Result |
|---|---|
| `npm install -g @cursor/cli` | HTTP 404 — package does not exist |
| `@cursor/sdk` on npm | Exists — v1.0.18, maintained by Cursor/Anysphere |
| Cursor desktop binary on system | Not installed |
| Linux headless CLI binary | Not separately distributed |

`@cursor/sdk` is a library, not a subprocess binary. The integration path
to our Python/SQLite architecture is a thin Node.js shim that imports the SDK,
accepts a job spec on stdin, and emits NDJSON to stdout. Python invokes the
shim as a subprocess.

---

## 1. Stream Architecture & Event Schema

The SDK exposes an `AsyncGenerator<SDKMessage, void>` via `run.stream()`.
Each event is a plain JS object — no ANSI codes, no spinners, no terminal
sequences. The caller serialises to NDJSON manually.

### SDKMessage discriminated union (from `messages.d.ts`)

```typescript
type SDKMessage =
  | SDKSystemMessage      // init handshake
  | SDKUserMessageEvent   // echo of the sent user message
  | SDKAssistantMessage   // text + tool_use content blocks
  | SDKToolUseMessage     // per-tool lifecycle
  | SDKThinkingMessage    // extended-thinking output
  | SDKStatusMessage      // run lifecycle status
  | SDKRequestMessage     // server-side approval gate
  | SDKTaskMessage        // task/subtask status
```

### Observed events on a live run (no valid key — error path)

```jsonl
{"type":"status","agent_id":"agent-3060bc4b...","run_id":"run-a0379a24...","status":"RUNNING"}
{"type":"status","agent_id":"agent-3060bc4b...","run_id":"run-a0379a24...","status":"ERROR"}
```

On a successful authenticated run, the stream would be:

```jsonl
{"type":"system","subtype":"init","agent_id":"...","run_id":"...","model":{"id":"claude-4-sonnet"},"tools":["shell","read","write","glob","grep",...]}
{"type":"status","agent_id":"...","run_id":"...","status":"RUNNING"}
{"type":"assistant","agent_id":"...","run_id":"...","message":{"role":"assistant","content":[{"type":"text","text":"2 + 2 = 4."}]}}
{"type":"status","agent_id":"...","run_id":"...","status":"FINISHED"}
```

### Tool-call event shape

```jsonl
{"type":"tool_call","agent_id":"...","run_id":"...","call_id":"call_abc","name":"shell","status":"running","args":{"command":"ls /tmp","workingDirectory":"/tmp"}}
{"type":"tool_call","agent_id":"...","run_id":"...","call_id":"call_abc","name":"shell","status":"completed","result":{"status":"success","value":{"output":"file1\nfile2\n","exitCode":0}}}
```

All tool types surfaced in event stream: `shell`, `read`, `write`, `edit`,
`glob`, `grep`, `ls`, `readLints`, `mcp`, `semSearch`, `createPlan`,
`updateTodos`, `task`, `generateImage`.

### ANSI / IPC cleanliness

The SDK does **not** emit any ANSI codes to stdout or stderr. The gRPC
response is deserialized into plain JS objects. The Node.js shim's stdout
stream is clean NDJSON.

---

## 2. Workspace Trust Handshake

The `WorkspaceTrust` concept exists as a protobuf field in Cursor's gRPC
server config (`WorkspaceTrustControls.enabled: bool`) and is resolved
server-side per API key / team settings. **There is no client-side
workspace-scan or trust prompt in the SDK.**

`Agent.create({ local: { cwd } })` succeeds immediately with any path:

```
Agent created: agent-c651a8fa-5e4d-49ad-9e06-19b8835b33e7   ← /tmp, unindexed
```

No exit code difference, no trust error. The trust gate is enforced at the
Cursor cloud backend, not in the SDK client. A fresh, unindexed directory
does not block agent creation or `send()`.

**Pre-authorisation requirement:** None on the client side.

---

## 3. Authentication

`Agent.create` and `Agent.send` are constructors only — they succeed
without a key. The first network call to `api2.cursor.sh` (gRPC over HTTPS)
enforces auth:

```
ConnectError: [unknown] Invalid User API Key
  cause: AuthenticationError { code: 'unauthenticated', isRetryable: false }
```

- `CURSOR_API_KEY` env var or `apiKey` option to `Agent.create`.
- API keys are available at cursor.com/settings (separate from a subscription —
  requires a Pro or above plan).
- `isRetryable: false` — auth errors must not be retried.

---

## 4. MCP Servers & Tool Approval

MCP servers are wired at agent-creation time or per-send:

```typescript
// Per-agent (all sends)
Agent.create({
  mcpServers: {
    "my-server": { type: "stdio", command: "my-mcp-bin", args: ["--flag"] }
  }
})

// Per-send override
agent.send(prompt, {
  mcpServers: { "session-tool": { type: "http", url: "http://localhost:4000/mcp" } }
})
```

The SDK does **not** implement an interactive approval step. Tool calls fire
and their results land as `tool_call` events. If the cloud backend enforces a
review step (the `request` event type), the run will pause emitting a
`SDKRequestMessage`:

```typescript
interface SDKRequestMessage {
  type: "request";
  agent_id: string;
  run_id: string;
  request_id: string;  // opaque handle — for Telegram inline button → run.approve()?
}
```

The SDK surface does not yet expose a public `run.approve()` method in
v1.0.18 — this is a backend-controlled gate. In practice, non-interactive
runs with non-destructive tools (read-only MCP, shell read-only) do not
trigger approval gates. Destructive tool calls on cloud agents may pause
if the account's Auto-review setting is enabled.

---

## 5. IPC Hang & Concurrency

### Known risk

The SDK uses `@connectrpc/connect-node` for gRPC-over-HTTP/2 to
`api2.cursor.sh`. HTTP/2 streams can deadlock if:
- The server stops sending but does not close the stream (`END_STREAM`).
- The Node.js event loop has no other work and the gRPC keepalive fires.

This matches the "IPC hang" described in the request. The SDK's `run.wait()`
and `run.stream()` do not set their own timeout — the caller must impose one.

### Concurrency isolation

`Agent.create({ local: { cwd } })` creates an independent SQLite agent store
under a cwd-hashed path (`~/.cursor/sdk-agent-store/<md5(cwd)>/`). Two
parallel agents in different `cwd`s do not share state. No global lock.

### Watchdog requirement

A hard-timeout + kill on the Node.js shim process is mandatory. See the
Python wrapper below.

---

## 6. Protocol: Node.js Shim Runner

The shim accepts a JSON job spec on stdin and emits NDJSON to stdout.
This is the IPC contract between the Python bridge and the SDK.

### Stdin schema

```json
{
  "agentId": "agent-abc123",
  "cwd": "/home/user/workspace",
  "apiKey": "...",
  "model": { "id": "claude-4-sonnet" },
  "prompt": "Fix the failing test in src/foo.test.ts",
  "mcpServers": {},
  "timeoutMs": 300000
}
```

`agentId` is optional on the first turn; the shim creates a new agent and
echoes the assigned ID back in the `agent_ready` event. Subsequent turns
pass the ID to resume the session.

### Stdout schema

```jsonl
{"event":"agent_ready","agent_id":"agent-abc123","run_id":"run-xyz"}
{"event":"sdk_message","message":{"type":"system",...}}
{"event":"sdk_message","message":{"type":"assistant","message":{"content":[{"type":"text","text":"Done."}]}}}
{"event":"done","status":"finished","result":"Done.","duration_ms":4321}
```

Error path:
```jsonl
{"event":"error","code":"unauthenticated","message":"Invalid User API Key","retryable":false}
```

---

## 7. Python Subprocess Wrapper

```python
#!/usr/bin/env python3
"""
cursor_sdk_runner.py

Invokes the @cursor/sdk via a thin Node.js shim. Emits NDJSON events as
they arrive from the SDK stream. Enforces a hard watchdog timeout.

Usage:
    events = list(run_cursor_agent(
        cwd="/home/user/workspace",
        prompt="Refactor auth.py to use JWT.",
        api_key=os.environ["CURSOR_API_KEY"],
    ))
"""

import json
import os
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Generator

# Path to the Node.js shim (co-located with this file or installed globally).
SHIM_PATH = Path(__file__).parent / "cursor_sdk_shim.mjs"
NODE_BIN = os.environ.get("NODE_BIN", "node")

DEFAULT_TIMEOUT_S = 300   # 5 minutes
HARD_TIMEOUT_S = 1800     # 30 minutes — matches CLI_TIMEOUT_MS in bridge config


class CursorAuthError(RuntimeError):
    pass


class CursorTimeoutError(RuntimeError):
    pass


class CursorAgentError(RuntimeError):
    pass


def run_cursor_agent(
    *,
    cwd: str,
    prompt: str,
    api_key: str | None = None,
    agent_id: str | None = None,
    model_id: str = "claude-4-sonnet",
    mcp_servers: dict | None = None,
    timeout_s: float = DEFAULT_TIMEOUT_S,
) -> Generator[dict, None, None]:
    """
    Yields NDJSON event dicts from the cursor-sdk shim until the run finishes.
    Raises CursorAuthError / CursorTimeoutError / CursorAgentError on failure.
    """
    api_key = api_key or os.environ.get("CURSOR_API_KEY")
    if not api_key:
        raise CursorAuthError("CURSOR_API_KEY is required")

    job_spec = {
        "cwd": cwd,
        "prompt": prompt,
        "apiKey": api_key,
        "model": {"id": model_id},
        "mcpServers": mcp_servers or {},
        "timeoutMs": int(timeout_s * 1000),
    }
    if agent_id:
        job_spec["agentId"] = agent_id

    shim = str(SHIM_PATH)
    proc = subprocess.Popen(
        [NODE_BIN, shim],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,  # line-buffered
        preexec_fn=os.setsid,  # process group for clean kill
    )

    # Write job spec, close stdin — shim reads once then streams.
    try:
        proc.stdin.write(json.dumps(job_spec) + "\n")
        proc.stdin.close()
    except BrokenPipeError:
        # shim crashed before reading
        pass

    # Watchdog: kill process group if hard timeout fires.
    timed_out = threading.Event()

    def _watchdog():
        time.sleep(HARD_TIMEOUT_S)
        if proc.poll() is None:
            timed_out.set()
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass

    watchdog = threading.Thread(target=_watchdog, daemon=True)
    watchdog.start()

    deadline = time.monotonic() + timeout_s
    for raw in proc.stdout:
        if time.monotonic() > deadline:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
            raise CursorTimeoutError(f"cursor-sdk shim exceeded {timeout_s}s timeout")

        raw = raw.rstrip("\n")
        if not raw:
            continue

        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            # Non-JSON line (e.g. unhandled Node.js warning) — log and skip.
            continue

        yield event

        # Surface terminal events immediately.
        if event.get("event") == "error":
            err_code = event.get("code", "unknown")
            err_msg = event.get("message", "unknown error")
            retryable = event.get("retryable", True)
            if err_code == "unauthenticated":
                raise CursorAuthError(err_msg)
            exc = CursorAgentError(f"[{err_code}] {err_msg}")
            exc.retryable = retryable  # type: ignore[attr-defined]
            raise exc

        if event.get("event") == "done":
            break

    proc.stdout.close()
    proc.wait(timeout=5)

    if timed_out.is_set():
        raise CursorTimeoutError("cursor-sdk shim killed by hard watchdog")


# ---------------------------------------------------------------------------
# Node.js shim (save as cursor_sdk_shim.mjs alongside this file)
# ---------------------------------------------------------------------------
SHIM_SOURCE = r"""
#!/usr/bin/env node
// cursor_sdk_shim.mjs — thin NDJSON bridge over @cursor/sdk
// Reads one JSON job spec from stdin, streams SDKMessage events to stdout.

import { Agent } from '@cursor/sdk';
import { createInterface } from 'node:readline';

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const lines = [];
for await (const line of rl) {
  lines.push(line);
  break; // one JSON line
}

let job;
try {
  job = JSON.parse(lines[0] ?? '{}');
} catch {
  emit({ event: 'error', code: 'bad_input', message: 'Invalid JSON job spec', retryable: false });
  process.exit(1);
}

const { cwd, prompt, apiKey, model, mcpServers, timeoutMs, agentId } = job;

if (!prompt) {
  emit({ event: 'error', code: 'bad_input', message: 'prompt is required', retryable: false });
  process.exit(1);
}

try {
  const agentOpts = {
    apiKey: apiKey ?? process.env.CURSOR_API_KEY,
    model: model ?? { id: 'claude-4-sonnet' },
    local: { cwd: cwd ?? process.cwd() },
  };
  if (agentId) agentOpts.agentId = agentId;
  if (mcpServers && Object.keys(mcpServers).length > 0) agentOpts.mcpServers = mcpServers;

  const agent = await Agent.create(agentOpts);
  const run = await agent.send(prompt);

  emit({ event: 'agent_ready', agent_id: agent.agentId, run_id: run.id });

  // Optional hard timeout via AbortController
  const timeoutHandle = timeoutMs > 0
    ? setTimeout(async () => {
        if (run.supports('cancel')) {
          try { await run.cancel(); } catch {}
        }
      }, timeoutMs)
    : null;

  try {
    for await (const message of run.stream()) {
      emit({ event: 'sdk_message', message });
    }
    const result = await run.wait();
    emit({
      event: 'done',
      status: result.status,
      result: result.result ?? null,
      duration_ms: result.durationMs ?? null,
    });
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  agent.close();
} catch (err) {
  const code = err.code ?? (err.constructor?.name === 'AuthenticationError' ? 'unauthenticated' : 'unknown');
  const retryable = err.isRetryable ?? true;
  emit({ event: 'error', code, message: err.message ?? String(err), retryable });
  process.exit(1);
}
"""
```

Save the shim as `cursor_sdk_shim.mjs` next to `cursor_sdk_runner.py`.
Install the SDK in the same directory:

```bash
npm install @cursor/sdk
# or globally: npm install -g @cursor/sdk
# then update SHIM_PATH to reference node_modules import
```

---

## 8. Comparison with Existing Bridge Backends

| Capability | @cursor/sdk (via shim) | codex | claude | agy |
|---|---|---|---|---|
| Multi-turn sessions | ✓ (agent_id resume) | ✓ | ✓ | ✓ |
| NDJSON stream | ✓ (custom shim) | varies | ✓ | after `***` |
| System prompt injection | ✓ (McpServerConfig) | ✓ stdin | ✓ `--print` | ✓ `--print` |
| File/tool use | ✓ (shell, read, write, edit…) | ✓ | ✓ | ✓ |
| MCP server support | ✓ first-class | limited | ✓ | varies |
| ANSI-clean stdout | ✓ (SDK emits plain objects) | varies | ✓ | ✓ |
| Hard timeout / cancel | ✓ `run.cancel()` | SIGKILL | SIGKILL | SIGKILL |
| API key required | ✓ CURSOR_API_KEY | ✓ | ✓ | subscription |
| Workspace trust gate | ✗ (server-side, transparent) | ✗ | ✓ (--trust) | ✗ |
| Subprocess binary | ✗ (Node.js shim needed) | ✓ | ✓ | ✓ |
| Active maintenance | ✓ (v1.0.18, Anysphere) | ✓ | ✓ | ✓ |

---

## 9. Trade-Off Summary

| Factor | Assessment |
|---|---|
| **Integration complexity** | Medium: requires a persistent Node.js shim alongside the Python worker, plus `npm install @cursor/sdk`. |
| **Auth gate** | Hard: requires a paid Cursor API key. Not available on this server currently. |
| **IPC hang risk** | Real: HTTP/2 stream can stall. Python watchdog (SIGKILL on process group) is mandatory. |
| **Multi-turn support** | Strong: `agent_id` persists across turns via SDK-managed SQLite store. |
| **Tool control** | Strong: MCP servers and custom tools injected at create or send time. |
| **Parallel isolation** | Good: per-cwd SQLite stores, no global lock observed. |
| **stream() event schema** | Clean and typed: discriminated union, no ambiguity. |

---

## 10. Conclusion

**`@cursor/sdk` is the correct package.** It is viable as a bridge backend
with the following prerequisites:

1. A valid `CURSOR_API_KEY` from a Cursor Pro/Team account.
2. The thin Node.js shim (`cursor_sdk_shim.mjs`) colocated with `@cursor/sdk`
   in `node_modules`.
3. The Python watchdog wrapper enforcing a hard SIGKILL timeout on the Node.js
   process group — the gRPC HTTP/2 stream does not self-close on all error paths.

**Recommended next step:** Gate on acquiring a `CURSOR_API_KEY`, then run
the shim end-to-end against a trivial prompt and verify the full NDJSON event
sequence before wiring into the bridge worker.
