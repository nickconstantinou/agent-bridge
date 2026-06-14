# cursor-agent CLI — Headless Worker Feasibility Spike

**Date:** 2026-06-14
**Verdict: NO — not viable as a headless agent-bridge backend.**

---

## Identity Clarification (Critical)

The `cursor-agent` package installed from PyPI (v0.1.4,
`github.com/grapeot/devin.cursorrules`) is **not** the Cursor IDE's built-in
agent. It is a community project that emulates a Devin-style workflow _inside_
the Cursor IDE by scaffolding helper scripts and a `.cursorrules` system-prompt
file. The Cursor IDE's actual coding agent runs inside VS Code and has no
standalone headless CLI.

What ships with the package:

| Binary | Role |
|---|---|
| `cursor-agent` | Project initialiser — copies `.cursorrules`, `.env.example`, `requirements.txt` into a directory |
| `cursor-llm` | Single-turn LLM wrapper (OpenAI, Anthropic, Gemini, DeepSeek, local) |
| `cursor-scrape` | Playwright-based web scraper |
| `cursor-search` | DuckDuckGo search wrapper |
| `cursor-verify` | Setup verifier — **broken** (ImportError on import in v0.1.4) |

---

## 1. Stream Cleanliness & IPC Control

### Flags

```
cursor-llm --prompt PROMPT
           [--provider {openai,anthropic,gemini,local,deepseek}]
           [--model MODEL]
```

No `--json`, `--quiet`, `--headless`, `--non-interactive`, or any output-format
flag exists.

### Stdout

Clean. On success the model's text response is printed to stdout with no
framing, no ANSI codes, no spinner output. `print(response)` → `sys.stdout`.

### Stderr

Polluted. Every invocation emits a multi-line `FutureWarning` to stderr before
the process does anything else:

```
/path/to/cursor_agent/tools/llm_api.py:3: FutureWarning:
All support for the `google.generativeai` package has ended...
```

This fires at module import and cannot be suppressed via CLI flags. It can be
filtered by the caller (`stderr=subprocess.PIPE` + discard or regex strip), but
it will be present on every call until the package upgrades its dependency.

### ANSI / escape codes

None observed in stdout. The FutureWarning on stderr is plain text.

### Verdict

Stdout is clean enough to consume programmatically. The stderr warning is a
nuisance but containable. **Not a blocker on its own.**

---

## 2. Session Management & State Persistence

### Conversation history

None. `cursor-llm` is single-turn only. Each invocation creates a fresh
`messages=[{"role": "user", "content": prompt}]` array and makes one API call.
There is no `--session-id`, `--resume`, `--conversation`, or `--history` flag.
There is no local file that accumulates turns.

```python
# Entire state model in llm_api.py:
response = client.messages.create(
    model=model,
    max_tokens=1000,
    messages=[{"role": "user", "content": prompt}]
)
return response.content[0].text
```

### Disk state from `cursor-agent .`

The initialiser writes three files into the target directory:
- `.cursorrules` — system-prompt template
- `.env.example` — API key placeholders
- `requirements.txt` — dependency list

These are static, not runtime state. Two parallel `cursor-agent .` calls in
different directories write independent copies from the same package template.

### Global lock files

None found. No `~/.cursor/`, no `~/.config/cursor*`, no cross-process locking.
Two parallel `cursor-llm` invocations are fully isolated as they make
independent HTTP calls.

### Verdict

**No multi-turn session support at all.** Wrapping `cursor-llm` in a bridge
would require the bridge to maintain the full conversation buffer itself and
re-send the entire history on every turn — a significant reimplementation of
what Codex, Claude CLI, and Agy already provide natively.

---

## 3. Context & Rule Adherence

### `.cursorrules` auto-ingestion

`cursor-llm` does **not** read `.cursorrules` or `AGENTS.md`. These files are
consumed by the Cursor IDE's editor agent, not by the `cursor-llm` binary. The
CLI has no awareness of the current working directory's instruction files.

### Runtime system-prompt injection

No `--system` or `--system-prompt` flag exists. The only way to inject a system
prompt is to prepend it to the `--prompt` string, which merges system and user
context into a single user turn. This degrades model behaviour and conflicts
with providers that treat system prompts differently.

Confirmed by source inspection — `query_llm()` builds a hardcoded single-message
array with no system message slot:

```python
messages=[{"role": "user", "content": prompt}]
```

### Verdict

**System-prompt injection is not supported.** Our bridge's `wrapTelegramPrompt()`
and soul-contract injection pattern cannot be applied cleanly. Every call would
require the caller to prepend the entire system context to the user message,
which providers may interpret differently and which inflates token counts.

---

## 4. Error Handling & Exit Codes

| Failure mode | Behaviour | Exit code |
|---|---|---|
| Missing API key | `Error querying LLM: ANTHROPIC_API_KEY not found` → stderr | 1 |
| Wrong provider name | argparse error → stderr | 2 |
| Broken `cursor-verify` binary | `ImportError` at startup → stderr | 1 |
| LLM API error | `Error querying LLM: <exception message>` → stderr | 1 |
| Keyboard interrupt | `Query interrupted by user` → stderr | 1 |

Exit codes are standard and predictable. Errors go to stderr, success output to
stdout. No hanging on failure was observed.

The `cursor-verify` binary is broken in v0.1.4 with an `ImportError` —
`cannot import name 'main' from cursor_agent.tools.verify_setup`. This
indicates the package is not production-quality.

---

## 5. Parallel Isolation Test

```bash
# Ran simultaneously:
cd /tmp/test-a && cursor-agent . &
cd /tmp/test-b && cursor-agent . &
wait
```

Result: both completed independently. No cross-directory file conflicts. The
`.cursorrules` files are identical copies of the package template — expected.
No global state was written outside the target directories.

**Parallel `cursor-llm` calls** would be isolated by design (stateless HTTP).
But concurrent multi-turn sessions cannot be built on top of this without the
bridge owning the full conversation buffer per user, which defeats the purpose.

---

## 6. PoC Wrapper — Minimal Viable Script

This is what a working single-turn wrapper looks like. It illustrates the
integration ceiling:

```bash
#!/bin/bash
# cursor-llm-bridge-poc.sh
# Single-turn, clean-stdout wrapper for cursor-llm.
# Caller must pass full conversation context in PROMPT (no native multi-turn).

PROMPT="$1"
PROVIDER="${2:-anthropic}"
MODEL="${3:-claude-3-sonnet-20240229}"

if [[ -z "$PROMPT" ]]; then
  echo "Usage: $0 <prompt> [provider] [model]" >&2
  exit 1
fi

# Suppress stderr FutureWarning; capture only stdout
OUTPUT=$(cursor-llm \
  --prompt "$PROMPT" \
  --provider "$PROVIDER" \
  --model "$MODEL" \
  2>/dev/null)

EXIT_CODE=$?

if [[ $EXIT_CODE -ne 0 ]]; then
  # Re-run to surface the actual error message to our stderr
  cursor-llm --prompt "$PROMPT" --provider "$PROVIDER" --model "$MODEL" \
    >/dev/null 2>&1 || true
  echo "cursor-llm failed (exit $EXIT_CODE)" >&2
  exit $EXIT_CODE
fi

printf '%s' "$OUTPUT"
```

Python variant (closer to bridge architecture):

```python
#!/usr/bin/env python3
"""
Minimal cursor-llm subprocess wrapper.
Demonstrates the integration ceiling: single-turn, no session, no system prompt.
"""
import subprocess
import sys


def query_cursor_llm(prompt: str, provider: str = "anthropic", model: str | None = None) -> str:
    args = ["cursor-llm", "--prompt", prompt, "--provider", provider]
    if model:
        args += ["--model", model]

    result = subprocess.run(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,   # discard FutureWarning noise
        text=True,
        timeout=60,
    )

    if result.returncode != 0:
        # stderr may have a useful error message despite the warning noise
        err = result.stderr.strip().splitlines()
        clean_err = next((l for l in reversed(err) if "Error" in l or "error" in l), "unknown error")
        raise RuntimeError(f"cursor-llm exited {result.returncode}: {clean_err}")

    return result.stdout.strip()


if __name__ == "__main__":
    prompt = " ".join(sys.argv[1:]) or "Say only: hello"
    try:
        print(query_cursor_llm(prompt))
    except RuntimeError as e:
        print(e, file=sys.stderr)
        sys.exit(1)
```

---

## 7. Comparison with Existing Bridge Backends

| Capability | cursor-llm | codex | claude | agy |
|---|---|---|---|---|
| Multi-turn sessions | ✗ | ✓ | ✓ | ✓ |
| `--resume` / session ID | ✗ | ✓ | ✓ | ✓ |
| System prompt injection (CLI) | ✗ | ✓ (stdin) | ✓ (`--print`) | ✓ (`--print`) |
| File/tool use (agentic) | ✗ | ✓ | ✓ | ✓ |
| `.cursorrules` / `AGENTS.md` auto-ingest | ✗ | ✓ | ✓ | ✓ |
| ANSI-clean stdout | ✓ | varies | ✓ | ✓ (after `***`) |
| Stderr noise | FutureWarning | low | low | low |
| Predictable exit codes | ✓ | ✓ | ✓ | ✓ |
| Active maintenance | ✗ (v0.1.4, broken verify) | ✓ | ✓ | ✓ |

---

## 8. Trade-Off Summary

| Factor | Assessment |
|---|---|
| **Latency** | Fast for single-turn (direct provider HTTP). No overhead from session resumption. Irrelevant since multi-turn is unsupported. |
| **Reliability** | `cursor-verify` is broken in v0.1.4. FutureWarning indicates dependency rot. Not suitable for production. |
| **Integration complexity** | High. Bridge would need to maintain full per-user conversation buffers, inject system prompts manually, and work around the single-message API shape. |
| **Provider flexibility** | Moderate advantage: supports OpenAI, Anthropic, Gemini, DeepSeek, and local LLMs from one binary. But our bridge already handles provider routing via env config. |
| **Agentic capability** | None. No file read/write, no tool use, no code execution. It is a prompt → response wrapper only. |

---

## Conclusion

**cursor-agent is not viable as a headless agent-bridge worker.**

It is a project scaffolding tool plus a thin single-turn LLM wrapper built for
use inside the Cursor IDE, not for orchestration pipelines. The critical gaps —
no multi-turn session support, no system-prompt injection via CLI, no agentic
tool use — would require reimplementing what Codex, Claude CLI, and Agy already
provide, without gaining any offsetting benefit.

If the intent was to evaluate the **Cursor IDE's built-in agent**, that agent
has no standalone CLI as of 2026-06-14. It is exclusively an IDE-embedded
feature (VS Code extension) with no subprocess API.

**Recommended action:** No further investment. Continue with the existing
Codex/Claude/Agy backend pool.
