# Development Practice — Red-Green-Refactor TDD

**All implementation work uses red-green-refactor TDD. No exceptions.**

1. **Red** — write a failing test that describes the desired behaviour before touching production code.
2. **Green** — make the smallest change that passes the test.
3. **Refactor** — clean up with tests green.

By work type:
- **Feature:** write the first acceptance or unit test before implementation.
- **Bug fix:** reproduce with a failing regression test before fixing.
- **Refactor:** add characterization tests that lock existing behaviour before restructuring.

## Verification protocol — do this every cycle

```bash
# After writing tests, before writing implementation:
npm test   # must show the new test(s) FAILING — confirm red

# After writing implementation:
npm test   # must show all tests PASSING — confirm green
```

If you cannot confirm the red state, stop. The test is either wrong, already covered, or testing nothing.

## Commit discipline

**Tests and implementation must be separate commits.** Never bundle them together.

```
commit 1: test: add failing tests for <feature>    ← red state
commit 2: feat/fix: implement <feature>            ← green state
```

The commit history must prove that the test existed before the implementation. A single commit containing both test and production code is not TDD — it is tests-alongside-code with no proof of the red state.

Planning note: when writing or reviewing an implementation plan, ensure every phase explicitly requires:
1. Write tests → run `npm test` → confirm red → commit
2. Write implementation → run `npm test` → confirm green → commit

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

# Service Restart Safety

**Never trigger `sudo systemctl restart agent-bridge-<bot>` from within an active bot session.**

When the restart command runs inside a bot session, systemd sends SIGTERM to the entire control group — which includes the currently-running Claude CLI process. This kills the session that issued the restart, which looks like the bot went unresponsive.

The correct restart pattern is to run restarts from outside any active bot session (e.g. from the server terminal or Claude Code desktop), one service at a time with a short timeout:

```bash
sudo systemctl restart agent-bridge-antigravity
sudo systemctl restart agent-bridge-codex
sudo systemctl restart agent-bridge-claude
```

If the bot becomes unresponsive after a bad restart, send `/reset` to the affected bot on Telegram to clear any stale execution lock.

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
- **`silenceOnGreen`** — `HealthConfig.silenceOnGreen?: boolean` suppresses `sendReport` calls when `report.status === "green"`. The `HealthBridgeBot.handleReport` path already silences green by default; this flag brings scheduler-direct callers into line.
- **Content-crawler POC** — `~/content-crawler/scripts/health_check.py`; checks queue depth, failed items, stale workers, signal-feed age, disk space; enabled via `HEALTH_CONTENT_CRAWLER_ENABLED=1`

When modifying the health module, keep `_suggestFn` injectable — do not inline `generateSuggestion` in the scheduler.

---

# Image Generation

Use the **Agy (Gemini) CLI** for all image generation — not the raw `gemini` command invoked without context. Agy runs from its configured project directory with the correct settings, producing faster and more reliable results.

**Invocation pattern:**

```bash
GEMINI_CLI_PATH=/home/content-crawler/.nvm/versions/node/v20.20.2/bin/gemini

$GEMINI_CLI_PATH -y -p "Generate a photorealistic image of <description>. Use Imagen to generate directly — do not fetch from the web. Save the result as <output_path>."
```

**Key rules:**
- Always include `"Use Imagen to generate directly — do not fetch from the web."` to prevent the Unsplash/web-fetch detour.
- Save output to the user's bridge output dir: `/tmp/bridge-out/claude-<chatId>/`
- Run the command as a **background process** (`run_in_background: true`) then wait for the task notification before reporting.
- Verify the file exists and is a valid image (`file <path>`) before reporting success.
- Do not mention the output path in the Telegram response — the bridge delivers the file automatically.
