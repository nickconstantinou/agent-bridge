# Agent Bridge

[![npm](https://img.shields.io/npm/v/agent-bridge.svg)](https://www.npmjs.com/package/agent-bridge)
[![CI](https://github.com/nickconstantinou/agent-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/nickconstantinou/agent-bridge/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Run Codex, Antigravity (Agy), Claude, and Kimchi from Telegram — each with its own dedicated bot, or all in one interactive bot with live CLI switching, model selection, and capacity fallback.

## Features

- **Four CLI backends** — Codex, Antigravity (Agy), Claude, and Kimchi, each with a dedicated Telegram bot
- **Interactive unified bot** — switch between CLIs with `/cli` without losing conversation context
- **Model selection** — `/models` shows available models from each CLI's own API/cache; capacity fallback retries automatically
- **Effort control** — `/effort` sets standardized reasoning effort per CLI (`low`, `medium`, `high`, `xhigh`, `max`); unsupported levels fall back safely and Agy reports an explicit no-op
- **Automatic fallback** — when a provider hits capacity, the interactive bot compacts the current conversation through the healthy caller-selected provider first, excludes exhausted providers, then switches CLIs with the compacted context and visible provider/model metadata
- **Persistent sessions** — each chat/topic gets its own CLI session, stored in SQLite and resumed across restarts
- **Group and topic support** — per-user, per-topic session isolation in Telegram supergroups
- **Discord interactive bot** — same shared engine and CLI fallback semantics for Discord channels and threads
- **Streaming responses** — live output updates during long-running CLI calls
- **Async jobs** — long tasks run in the background; `/jobs`, `/job`, `/stop`, `/result`, and `/events` control them
- **Project memory** — persistent FTS-backed memory shared across CLIs; `/compact` is the single automatic durable-memory distillation path
- **Source-controlled prompt contracts** — reviewed role/mode prompts and lifecycle skills are loaded only from the repository
- **Dormant role assignments** — explicit Technical Lead, Code Worker, and Documentation Steward CLI/model preferences can be validated, versioned, persisted, and inspected without changing current worker routing
- **Health monitoring** — pluggable health checks with Telegram reports and optional CLI-powered suggestions
- **Engineering worker** — queue feature, defect, refactor, implementation, GitHub, and PR lifecycle work with human merge approval
- **Systemd deployment** — installer and service templates for production hosting

## Supported CLIs

| CLI | Command | Session resume | Model flag |
|-----|---------|----------------|------------|
| Codex | `codex` | `codex exec resume <id>` | `--model <name>` |
| Antigravity | `agy` | `--conversation <uuid>` | Settings file (`~/.gemini/antigravity-cli/settings.json`) |
| Claude | `claude` | `--resume <id>` | `--model <name>` |
| Kimchi | `kimchi` | `--resume <uuid>` | `--model <name>` |

## Requirements

- Node.js 24+
- At least one supported CLI installed and authenticated
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your Telegram user ID (from [@userinfobot](https://t.me/userinfobot))

## Install

```bash
npm install -g agent-bridge
```

Or from source:

```bash
git clone https://github.com/nickconstantinou/agent-bridge.git
cd agent-bridge
npm ci
npm run build
```

## Quick start

1. Copy an example env file:

```bash
cp .env.example .env.interactive
```

2. Add your Telegram token and allowed user ID:

```bash
TELEGRAM_BOT_TOKEN_INTERACTIVE=123456:ABC-DEF...
TELEGRAM_ALLOWED_USER_IDS=123456789
```

3. Start the interactive bot:

```bash
npm run start:interactive
```

Or start a dedicated bot:

```bash
npm run start:codex
npm run start:antigravity
npm run start:claude
npm run start:kimchi
```

## Interactive bot

The interactive bot exposes all installed CLIs through one Telegram bot. Use `/cli` to switch:

```
/cli
```

The active CLI is stored per chat/topic and survives restarts. When the active provider is at capacity, the bot automatically switches to the next CLI in `INTERACTIVE_CLI_CHAIN`, carrying recent context forward. Before that switch, it first attempts structured compaction through the healthy caller-selected provider/model, excludes exhausted providers, and falls back through the bounded `BRIDGE_COMPACTION_CHAIN` only when needed. The handoff message reports the actual compaction provider/model, or explicitly reports bounded local/no-summary fallback when no healthy provider succeeds. This preserves intent without sending context back to a provider already known to be exhausted.

### Commands

| Command | Description |
|---------|-------------|
| `/cli` | Show active CLI and switch keyboard |
| `/models` | Choose a model for the active CLI |
| `/effort` | Choose reasoning effort for the active CLI |
| `/reset` | Clear the active CLI session |
| `/context` | Show current conversation/context status |
| `/compact` | Summarize conversation and reset the CLI session |
| `/jobs` | List worker jobs or active async runs, depending on surface |
| `/job <id>` | Show worker job details |
| `/stop <id>` | Cancel an async run |
| `/result <id>` | Show final output for an async run |
| `/events <id>` | Show event timeline for an async run |

## Engineering worker

The worker bot provides a durable software-engineering queue and PR lifecycle while keeping merge authority human-controlled.

| Command | Description |
|---------|-------------|
| `/feature <brief>` | Create a feature-planning job |
| `/review [repo]` | Queue a defect scan |
| `/refactor [repo]` | Queue a refactor scan |
| `/issues` | List proposed work items |
| `/issue <id>` | Show a work item |
| `/jobs` | List active and pending worker jobs |
| `/job <id>` | Show a worker job |
| `/approvals` | List pending approval and merge actions |
| `/github-issues [repo]` | List open GitHub issues for import |
| `/import-issue owner/repo#123` | Import a GitHub issue into the worker queue |
| `/repo` | Set the default repository for the current chat |
| `/chain` | Show configured desired role assignments as `configured_dormant` when present, state that role routing is disabled, and show the effective legacy interactive/code/scribe fallback chains |

Current role assignments are desired state only. They do not route any existing handler or interactive job. Capability resolution, role-native permissions, and active role orchestration remain later Issue #159 slices.

## Configuration

Each service reads one env file. Copy `.env.example` and set the variables for the service you run.

| Variable | Surface | Default | Purpose |
|----------|---------|---------|---------|
| `TELEGRAM_BOT_TOKEN_CODEX` | Dedicated Codex | — | Telegram bot token |
| `TELEGRAM_BOT_TOKEN_ANTIGRAVITY` | Dedicated Agy | — | Telegram bot token |
| `TELEGRAM_BOT_TOKEN_CLAUDE` | Dedicated Claude | — | Telegram bot token |
| `TELEGRAM_BOT_TOKEN_KIMCHI` | Dedicated Kimchi | — | Telegram bot token |
| `TELEGRAM_BOT_TOKEN_INTERACTIVE` | Interactive | — | Telegram bot token |
| `TELEGRAM_BOT_TOKEN_WORKER` | Worker | — | Telegram bot token |
| `TELEGRAM_BOT_TOKEN_HEALTH` | Health | — | Telegram bot token |
| `TELEGRAM_ALLOWED_USER_IDS` | Telegram | — | Comma-separated allowed Telegram user IDs |
| `DISCORD_BOT_TOKEN` | Discord | — | Discord bot token |
| `DISCORD_ALLOWED_USER_IDS` | Discord | — | Comma-separated allowed Discord user snowflakes |
| `DISCORD_GUILD_ID` | Discord | — | Optional guild for immediate slash-command registration |
| `CODEX_COMMAND` | Codex | `codex` | CLI executable |
| `ANTIGRAVITY_COMMAND` | Agy | `agy` | CLI executable |
| `CLAUDE_COMMAND` | Claude | `claude` | CLI executable |
| `KIMCHI_COMMAND` | Kimchi | `~/.local/bin/kimchi` | CLI executable |
| `CODEX_MODEL_PREFERENCE` | Codex | — | Comma-separated model fallback order |
| `ANTIGRAVITY_MODEL_PREFERENCE` | Agy | — | Comma-separated model fallback order |
| `CLAUDE_MODEL_PREFERENCE` | Claude | — | Comma-separated model fallback order |
| `KIMCHI_MODEL_PREFERENCE` | Kimchi | built-in list | Comma-separated model fallback order |
| `CODEX_PROJECT_DIR` | Dedicated Codex | `BRIDGE_PROJECT_DIR` | CLI working directory |
| `ANTIGRAVITY_PROJECT_DIR` | Dedicated Agy | `BRIDGE_PROJECT_DIR` | CLI working directory |
| `CLAUDE_PROJECT_DIR` | Dedicated Claude | `BRIDGE_PROJECT_DIR` | CLI working directory |
| `KIMCHI_PROJECT_DIR` | Dedicated Kimchi | `BRIDGE_PROJECT_DIR` | CLI working directory |
| `INTERACTIVE_PROJECT_DIR` | Interactive | `BRIDGE_PROJECT_DIR` | CLI working directory |
| `WORKER_DEFAULT_REPO` | Worker | — | Default `owner/repo` for worker commands |
| `INTERACTIVE_CLI_CHAIN` | Interactive | `codex,claude,antigravity` | CLI fallback order after model fallbacks are exhausted |
| `BRIDGE_COMPACTION_CHAIN` | Interactive/Worker | — | Optional ordered `provider[:model]` recovery targets; the healthy caller-selected provider is first, duplicates/invalid targets and exhausted providers are excluded, and Kimchi remains fail-closed |
| `BRIDGE_COMPACTION_MAX_ATTEMPTS` | Interactive/Worker | `3` | Maximum provider/model targets tried for each structured compaction output; bounded to 8 |
| `BRIDGE_COMPACTION_REPAIR_ATTEMPTS` | Interactive/Worker | `1` | Invalid structured-output repair attempts per provider/model target; bounded to 0 or 1 |
| `WORKER_ENABLED` | Worker | `false` | Master switch for autonomous job commands |
| `WORKER_CLI_CHAIN` | Worker | `codex,claude,antigravity` | CLI fallback order for worker interactive chat |
| `WORKER_CODE_CLI_CHAIN` | Worker | `codex,claude` | Code-writing job fallback order; `antigravity` is stripped if present |
| `WORKER_SCRIBE_CLI_CHAIN` | Worker | `antigravity,codex,claude` | Read-only/prose worker job fallback order for scans, plans, summaries, docs |
| `WORKER_ROLE_ASSIGNMENTS_JSON` | Worker | — | Optional exact three-role desired assignment array; persisted as `configured_dormant` and never used for current dispatch |
| `WORKER_ROLE_ASSIGNMENT_SCOPE` | Worker | `worker:default` | Bounded scope key for dormant desired role-assignment revisions |
| `WORKER_CODE_CLI_COMMAND` | Worker | first `WORKER_CODE_CLI_CHAIN` entry | Primary CLI command for code-writing jobs |
| `WORKER_SCRIBE_CLI_COMMAND` | Worker | `DEFECT_SCAN_CLI_COMMAND` or first `WORKER_SCRIBE_CLI_CHAIN` entry | Primary CLI command for read-only/prose jobs |
| `BRIDGE_ASYNC_ENABLED` | All | `true` | Enable streaming (disable for sync/plain mode) |
| `BRIDGE_EXECUTION_MODE` | All | `safe` | `safe` or `trusted` (bypasses CLI approval prompts) |
| `BRIDGE_ADVISOR_ENABLED` | Companion/Worker | `false` | Enable frontier advisor calls; kill switch for the capability |
| `BRIDGE_ADVISOR_MODE` | Companion/Worker | `manual` | `manual`, `suggest`, or `auto` consultation policy |
| `BRIDGE_ADVISOR_CHAIN` | Companion/Worker | — | Up to two ordered `provider:model` targets; tool-free invocation requires claude or codex targets |
| `BRIDGE_ADVISOR_MAX_CALLS_PER_TURN` | Companion | `1` | Maximum logical advisor requests for one Telegram/agent turn |
| `BRIDGE_ADVISOR_MAX_CALLS_PER_TASK` | Worker | `2` | Maximum logical advisor requests for one worker task |
| `BRIDGE_ADVISOR_TIMEOUT_MS` | Companion/Worker | `120000` | Hard timeout for each advisor provider attempt |
| `BRIDGE_ADVISOR_CONTEXT_MAX_CHARS` | Companion/Worker | `24000` | Redacted advisor context character budget |
| `PR_DEFECT_SCAN_ENABLED` | Worker | `false` | Enable pre-merge defect scanning when CI checks pass |
| `BRIDGE_PROJECT_DIR` | All | current working directory | Repo path (used as default CLI working dir and DB location) |

| `BRIDGE_ROOT_DIR` | All | `$HOME` | Fallback working dir when no `*_PROJECT_DIR` is set |

Effort levels are standardized as `low`, `medium`, `high`, `xhigh`, and `max`;
default is `medium`. Manual `/effort` overrides are persisted in SQLite. Worker
jobs select effort by task: scribe/read-only jobs use `medium`; code-writing
jobs (`tdd_implementation`, `orchestrated_task`) use `high`. Agy effort is an
explicit no-op because the current CLI exposes low/high variants through model
labels, not a standalone effort parameter.

`GEMINI_*` env names remain as deprecated compatibility aliases for
Antigravity/Agy deployments (`TELEGRAM_BOT_TOKEN_GEMINI`, `GEMINI_COMMAND`,
`GEMINI_MODEL_PREFERENCE`, `GEMINI_PROJECT_DIR`). Prefer the `ANTIGRAVITY_*`
names for new config; Agy is the supported replacement path for the older Gemini
CLI naming.

## Group and multi-user usage

The bot works in Telegram groups and supergroups.

### Adding a bot to a group — required order

**Do this before adding the bot to any group.** Changing settings after the fact requires removing and re-adding the bot to take effect.

1. **Disable Group Privacy in BotFather first** — `/mybots → [your bot] → Bot Settings → Group Privacy → Turn off`. Without this, Telegram silently drops all non-command, non-mention messages. The setting must be OFF *before* the bot joins the group; toggling it after the bot is already a member does not retroactively fix delivery — you must remove and re-add the bot.

2. **Add the bot to the group.**

3. **Grant admin rights if using forum topics** — In forum-style supergroups (groups with Topics enabled), the bot must be a group admin with at least "Post Messages" permission to reply in topics. Without this, responses fail with `TOPIC_CLOSED`. Standard groups without topics do not require admin rights.

Commands work with or without the bot username suffix: `/reset` and `/reset@mybotname` are both recognised.

Interactive bot command diagnostics are logged with sanitized group metadata:
`[interactive] update.received` for processable group updates and
`[interactive] update.ignored` with a `contentDetail` such as `new_chat_members`,
`photo`, `document`, or `command_for_other_bot` when an update is intentionally
skipped. If a dedicated bot responds in the group but the interactive bot does
not, compare BotFather privacy, remove/re-add the interactive bot after changing
privacy, and check these log lines before changing code.

**Per-topic sessions:** In forum-style supergroups, each topic gets its own isolated CLI session. Sending in Topic A and Topic B maintains independent conversation threads with the agent.

**Multiple users:** Set `TELEGRAM_ALLOWED_USER_IDS` to a comma-separated list of Telegram user IDs. Each user in a private chat has their own isolated session. In groups with multiple allowed users, sessions are isolated per-user per-topic.

```
TELEGRAM_ALLOWED_USER_IDS=111111111,222222222
```

## Discord channel and thread usage

Discord bots use channel snowflakes as the conversation boundary. A normal
server channel, a DM channel, and every Discord thread each have a distinct
`channel_id`, so each gets its own CLI lock, queue, model/session state, and
fallback-chain context.

The Discord interactive entry point adapts those snowflakes into deterministic
numeric aliases for the shared Telegram-shaped engine, then maps outbound sends
back to the original Discord channel snowflake. This preserves session isolation
while keeping the shared engine reusable.

Operational diagnostics are sanitized:

- `[discord-interactive] update.received` means an allowed user sent processable text
- `[discord-interactive] update.ignored` reports `unauthorized_author`, `bot_author`, or `empty_content`

Discord requirements:

- `DISCORD_ALLOWED_USER_IDS` must contain Discord user snowflake IDs, not usernames
- Message Content intent must be enabled in the Discord Developer Portal for plain-message routing
- Slash commands may be guild-scoped with `DISCORD_GUILD_ID` for immediate propagation

## Project memory

Project memory is stored in the bridge SQLite database in `project_memories`
with an FTS5 index. Spawned agents receive `AGENT_BRIDGE_CONTEXT_COMMAND` and
can retrieve or write guarded memories with:

```bash
"$AGENT_BRIDGE_CONTEXT_COMMAND" --memory
"$AGENT_BRIDGE_CONTEXT_COMMAND" --memory-query "<query>"
"$AGENT_BRIDGE_CONTEXT_COMMAND" --memory-add-json '<json>'
```

Successful responses may also include a hidden `agent-bridge-memory` sidecar;
the bridge strips it before delivery/history and stores valid candidates.

`/compact` is the single automatic durable-memory distillation path. The
former post-turn extractor (`BRIDGE_MEMORY_EXTRACTOR_ENABLED`) has been
removed; compaction produces both a conversation summary and validated
memory candidates in one deliberate step instead of running an extra CLI
call after every successful reply.

Set `BRIDGE_CONTEXT_INJECTION_POLICY=handoff_once` to inject full Agent
Bridge context only on a fresh session (no native CLI session, a pending
manual-switch/fallback handoff, or after `/compact`/invalid-session
recovery resets the session), then rely on the provider-native session
for continuity. Defaults to `always` (inject on every turn), matching
prior behavior. Context-command env vars (`AGENT_BRIDGE_CONTEXT_COMMAND`,
etc.) remain available under both policies. Recommended for
platform-managed workspaces; self-hosted deployments can leave it unset.

## Shared skills

`agent-bridge` also bundles reusable SDLC skills:

- `requirements-to-acceptance` — turn vague requests into requirements, non-goals, acceptance criteria, and verification steps
- `risk-based-test-strategy` — choose test depth based on blast radius and regression risk
- `red-green-refactor-tdd` — use red-green-refactor TDD for features, bug fixes, behavior changes, and refactoring
- `release-readiness-review` — check release, rollback, observability, docs, and post-release validation readiness
- `git-sandbox` — isolate work using git worktrees and feature branches, creating Draft PRs and validating changes before merging

Skills are stored once under:

```bash
~/.agents/skills/<skill-name>
```

Then they are projected into each CLI's native skills directory:

```bash
~/.codex/skills/<skill-name>
~/.gemini/antigravity/skills/<skill-name>
~/.claude/skills/<skill-name>
```

Global instruction files are not modified by the skills installer.
Fresh and deployment installs project all bundled skills into native CLI directories by default. Set `AGENT_BRIDGE_SKILLS=none` to skip this.

Manage skills manually:

```bash
npm run skills -- list
npm run skills -- install red-green-refactor-tdd
npm run skills -- verify
npm run skills -- uninstall red-green-refactor-tdd
```

Native CLI entries are symlinks by default. Use copy mode if a CLI does not discover symlinked skills correctly:

```bash
npm run skills -- install red-green-refactor-tdd --force --link-mode copy
```

During installation, override the default bundled set with a comma-separated list for non-interactive setup:

```bash
AGENT_BRIDGE_SKILLS=red-green-refactor-tdd,risk-based-test-strategy sudo bash scripts/install.sh
```

Optional install variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_BRIDGE_SKILLS` | all bundled skills | Comma-separated bundled skills to install during `install.sh` or `upgrade.sh`; use `none` to skip. |
| `AGENT_BRIDGE_SKILL_LINK_MODE` | `symlink` | Native CLI projection mode: `symlink` or `copy`. |

If verification reports stale symlinks or missing native entries, repair them with:

```bash
npm run skills -- verify --fix
```

## Health monitoring

The dedicated health service runs a `HealthScheduler` that polls plugins at a configurable cadence and sends formatted status reports to a Telegram chat.

### Built-in plugins

| Plugin | What it checks |
|--------|----------------|
| `SelfPlugin` | DB file accessibility, DB read liveness |
| `ServerPlugin` | System resource metrics (CPU load, RAM, swap, zombies, uptime) and security policies (UFW status, SSH key permissions, local environment file permissions) |
| `ExternalPlugin` | Spawns any shell command and parses its stdout as a `HealthReport` JSON |

`SelfPlugin` and `ServerPlugin` are active by default. `ExternalPlugin` wraps any system you want to monitor.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `HEALTH_MONITOR_ENABLED` | `false` | Set to `true` in the health service defaults to enable scheduled checks |
| `HEALTH_MONITOR_CADENCE_SECONDS` | `3600` | How often to run each plugin (seconds) |
| `HEALTH_MONITOR_AUTONOMY` | `report` | `report` — formatted report only; `suggest` — also spawns a CLI to diagnose and propose fixes |
| `HEALTH_MONITOR_CHAT_ID` | — | Telegram chat ID to receive reports; if unset, reports are logged to stdout only |
| `HEALTH_SUGGEST_BOT` | `claude` | Which installed CLI diagnoses amber/red reports: `codex`, `antigravity`, or `claude` |
| `HEALTH_SUGGEST_COMMAND` | bot default | Optional command override for the suggestion CLI. Defaults to `codex`, `agy`, or `claude` based on `HEALTH_SUGGEST_BOT` |
| `HEALTH_SUGGEST_MODEL_PREFERENCE` | — | Optional comma-separated model preference list for suggestion CLI fallback |
| `HEALTH_SERVER_MONITOR_ENABLED` | `1` | Set to `0` to disable the built-in server resource monitor plugin |
| `HEALTH_CPU_LOAD_AMBER_MULTIPLIER` | `1.0` | Threshold multiplier for CPU load warning (e.g. `1.0` * CPU count) |
| `HEALTH_CPU_LOAD_RED_MULTIPLIER` | `1.5` | Threshold multiplier for CPU load critical (e.g. `1.5` * CPU count) |
| `HEALTH_CPU_LOAD_AMBER_THRESHOLD` | — | Override to set absolute CPU load warning threshold |
| `HEALTH_CPU_LOAD_RED_THRESHOLD` | — | Override to set absolute CPU load critical threshold |
| `HEALTH_SWAP_MONITOR_ENABLED` | `true` | Set to `false` to disable the built-in swap check |
| `HEALTH_SWAP_AMBER_PCT` | `80` | Swap warning threshold percentage |
| `HEALTH_SWAP_RED_PCT` | `95` | Swap critical threshold percentage |
| `HEALTH_CONTENT_CRAWLER_ENABLED` | `0` | Set to `1` to enable the content-crawler external plugin |
| `HEALTH_CONTENT_CRAWLER_SCRIPT` | `~/content-crawler/scripts/health_check.py` | Override the script path |

### Additional Health Check Behaviors

- **Smart Swap Warnings**: To reduce false alerts, swap usage is only flagged as `amber` if RAM usage (memory status) is also not healthy (`green`). Critical status (`red`) is flagged unconditionally if swap usage exceeds `HEALTH_SWAP_RED_PCT` (default: 95%).
- **Version-Distance CLI Update Status**: Instead of reporting every update as a warning, updates report status based on how many versions behind the installed CLI is:
  - `>= 10` versions behind: `red` (critical)
  - `>= 3` versions behind: `amber` (warning)
  - `< 3` versions behind: `green` (nominal)
  The check message includes the version difference details.


### Suggest mode

When `HEALTH_MONITOR_AUTONOMY=suggest` the bridge sends a second message for every amber or red report. It routes the failing checks through the CLI configured in `HEALTH_SUGGEST_BOT` using the **same auth, invocation, parser, and Telegram rendering path as normal user messages** (`buildCliInvocation → runCli → parseCliResult → sendTelegramMessage`). The newer `HEALTH_CLI_*` variable names are also accepted as aliases, but `HEALTH_SUGGEST_*` is the documented form. The response appears as:

💡 *Suggested actions:*

1. Restarts the health monitor after a configuration or code change.

```bash
sudo systemctl restart agent-bridge-health
```

2. Raises the heap limit only if memory pressure is genuine.

```bash
echo 'NODE_OPTIONS="--max-old-space-size=512"' | sudo tee -a /etc/default/agent-bridge-health
sudo systemctl restart agent-bridge-health
```

To enable suggest mode, add to your `.env` file:

```bash
HEALTH_MONITOR_AUTONOMY=suggest
HEALTH_SUGGEST_BOT=claude          # or codex / antigravity
HEALTH_MONITOR_CHAT_ID=<your-telegram-user-id>
HEALTH_CONTENT_CRAWLER_ENABLED=1
```

### Report format

```
✅ *content-crawler* — GREEN
_All systems nominal_

✅ queue-depth: 12 items queued/pending (12)
✅ failed-items: 0 failed items (0)
✅ stale-workers: 0 items stuck in processing > 30m (0)
✅ signal-feed: signal-feed.json updated 0.2h ago (0.17)
✅ disk-space: 189.3 GB free (189.34)

_2026-06-02T12:18:17.150628_
```

### Adding your own health check script

Any script that exits 0 and prints a JSON `HealthReport` to stdout can plug in via `ExternalPlugin`. The shape:

```json
{
  "pluginName": "my-system",
  "status": "green",
  "checks": [
    { "name": "db-connection", "status": "green", "message": "connected", "value": 12 }
  ],
  "summary": "All systems nominal",
  "timestamp": "2026-06-02T12:00:00.000Z"
}
```

`status` and each check's `status` must be `"green"`, `"amber"`, or `"red"`.

**Python example** (save anywhere, pass path via env var):

```python
#!/usr/bin/env python3
import json
from datetime import datetime

def check_something():
    # your logic here
    return {"name": "my-check", "status": "green", "message": "ok"}

checks = [check_something()]
worst = "red" if any(c["status"] == "red" for c in checks) else \
        "amber" if any(c["status"] == "amber" for c in checks) else "green"

print(json.dumps({
    "pluginName": "my-system",
    "status": worst,
    "checks": checks,
    "summary": "All good" if worst == "green" else "Issues detected",
    "timestamp": datetime.now().isoformat(),
}))
```

Wire it in via env:

```bash
HEALTH_CONTENT_CRAWLER_ENABLED=1
HEALTH_CONTENT_CRAWLER_SCRIPT=/path/to/my_health.py
HEALTH_MONITOR_CHAT_ID=123456789
HEALTH_MONITOR_CADENCE_SECONDS=3600
```

Or register a second plugin directly in `src/index.ts`:

```typescript
healthPlugins.push(new ExternalPlugin({
  name: "my-system",
  command: "python3",
  args: ["/path/to/my_health.py"],
  timeoutMs: 30_000,
}));
```

The content-crawler POC (`scripts/health_check.py` in `~/content-crawler`) checks queue depth, failed items, stale workers, signal-feed freshness, and disk space.

## SOUL.md design

`SOUL.md` is the proposed bridge-level persona contract for all CLI-backed agents.

It should be runtime-injected by the bridge on every turn, including the first prompt after `/reset`, rather than written into `AGENTS.md`, `ANTIGRAVITY.md`, or `CLAUDE.md`.

The intended schema has 9 sections:

1. Identity — who the agent is, not just what it does
2. Values — decision-making when rules do not cover the case
3. Communication Style — tone, length, and formality
4. Expertise — specific tools and domains
5. Boundaries — rules that hold under pressure
6. Workflow — step-by-step process for tasks
7. Tool Usage — when and how to use tools
8. Memory Policy — what persists and what gets wiped
9. Example Interactions — concrete examples of good behaviour

See [`docs/soul.md`](docs/soul.md) for the full design, runtime injection order, reset behaviour, and suggested configuration.

## Systemd deployment

`sudo` is only required for the systemd install step. The installer prompts for each bot token and skips services whose token is left blank.

Systemd deployments require Node 24+. The current motivation is operational as well as compatibility related: direct Codex usage checks against ChatGPT's Codex usage endpoint returned Cloudflare HTML 403 responses under Node 20 on this host, while the same token and headers returned JSON under Node 24.

```bash
sudo bash scripts/install.sh
```

Or copy manually (include only the services you want):

```bash
sudo install -D -m 0644 systemd/agent-bridge-antigravity.service /etc/systemd/system/agent-bridge-antigravity.service
sudo install -D -m 0644 systemd/agent-bridge-codex.service /etc/systemd/system/agent-bridge-codex.service
sudo install -D -m 0644 systemd/agent-bridge-claude.service /etc/systemd/system/agent-bridge-claude.service
sudo install -D -m 0644 systemd/agent-bridge-interactive.service /etc/systemd/system/agent-bridge-interactive.service
sudo install -D -m 0644 systemd/agent-bridge-worker-bot.service /etc/systemd/system/agent-bridge-worker-bot.service
sudo install -D -m 0644 systemd/agent-bridge-health.service /etc/systemd/system/agent-bridge-health.service
sudo install -D -m 0644 systemd/agent-bridge-discord-interactive.service /etc/systemd/system/agent-bridge-discord-interactive.service
sudo sed -i 's/User=BRIDGE_USER/User='"$USER"'/g' /etc/systemd/system/agent-bridge-*.service
sudo systemctl daemon-reload
sudo systemctl enable --now agent-bridge-antigravity agent-bridge-codex
```

The repo service templates intentionally use `User=BRIDGE_USER` as an install-time placeholder. If you copy units manually, replace that placeholder with the real runtime account before starting the service; otherwise systemd fails with `status=217/USER`.

### Safe remote restart helper

For restarts triggered from an active bridge session, install the narrow helper
instead of granting passwordless `systemctl`:

```bash
sudo install -D -m 0750 -o root -g root scripts/restart-agent-bridge.sh /usr/local/sbin/restart-agent-bridge
sudo visudo -f /etc/sudoers.d/agent-bridge-restart
```

Sudoers content:

```sudoers
content-crawler ALL=(root) NOPASSWD: /usr/local/sbin/restart-agent-bridge
```

Use:

```bash
sudo -n /usr/local/sbin/restart-agent-bridge
```

The helper waits 5 seconds before restarting the fixed `agent-bridge-*` unit
list, giving the current bot response time to reach Telegram. Do not grant
`NOPASSWD: ALL` or passwordless raw `systemctl`.

Schema-changing production deployments must not use the restart helper. Use the
separately installed, reviewed guarded rollout helper and fixed inventory in
[`docs/GUARDED-ROLLOUT.md`](docs/GUARDED-ROLLOUT.md). Its merge or installation
does not authorize a rollout; production execution requires separate approval.

Only enable optional services after their `/etc/default/agent-bridge-*` file
exists and contains a real token.

Follow logs:

```bash
journalctl -u agent-bridge-antigravity -f
journalctl -u agent-bridge-codex -f
journalctl -u agent-bridge-claude -f
journalctl -u agent-bridge-interactive -f
journalctl -u agent-bridge-worker-bot -f
journalctl -u agent-bridge-discord-interactive -f
```

To update an existing deployment (updates npm packages, Claude Code CLI, and restarts services):

```bash
sudo bash scripts/upgrade.sh
```

## Development

```bash
npm test                    # run all tests (vitest)
npm test -- --watch         # watch mode
npm test -- test/cli.test.ts  # single file
```

## Architecture

Agent Bridge OSS is two products on one shared runtime: the **Companion Runtime**
(dedicated, interactive, and Discord bots — conversational, domain-agnostic) and
the **Engineering Worker** (worker bot — software-engineering jobs, Git/PR/CI),
both built on the **Shared Runtime** (SQLite, event store, memory, provider
adapters, CLI management, config, notifications). See
`docs/architecture/03-target-architecture.md` (ADR-008). Service and env var
names below predate the split and are unchanged.

```
Telegram / Discord update
    │
    ├── dedicated bot        → BridgeEngine → active CLI → streamed response
    ├── interactive bot      → /cli preference → BridgeEngine → fallback chain
    ├── worker bot command   → SQLite work_jobs → handler/checkpoint → Telegram report
    └── health service timer → HealthScheduler → Telegram report
```

## State

Each service has its own SQLite database by default (`DB_PATH`, WAL mode). The
main bridge database stores chat sessions and polling state; the worker database
also stores `work_items`, `work_jobs`, `approvals`, `github_links`, and dormant
`role_assignment_revisions` with child `role_assignments` rows.

Schema migration 2 retires the legacy SQLite `prompts` table. Schema migration 3
adds the dormant desired role-assignment tables. Ordinary production services
remain strict and require the guarded rollout helper to upgrade schema-version-2
databases before a schema-3 service starts.

| Row key | Value | Purpose |
|---------|-------|---------|
| `<chatId>` | — | Per-chat row; holds session IDs and execution lock |
| `$polling:codex` / `:antigravity` / `:claude` | last update_id | Telegram polling offset per bot |
| `codex` / `antigravity` / `claude` (in `settings`) | model name | Per-bot model override (set via `/models`) |
| `effort:codex` / `effort:antigravity` / `effort:claude` (in `settings`) | effort level | Per-bot effort override (set via `/effort`; Agy stored for parity only) |
| `interactive_cli_preference` | CLI kind | Per-chat active CLI for the unified interactive bot |

Session IDs are stored as columns (`codex_session_id`, `antigravity_session_id`, legacy `gemini_session_id`, `claude_session_id`) on the chat row. The migration adds `antigravity_session_id` and backfills it from legacy `gemini_session_id` automatically on first run.

Discord interactive rows use deterministic numeric aliases of Discord channel
snowflakes. These aliases are stable across restarts; runtime delivery maps the
alias back to the original channel snowflake before calling the Discord REST
API.

Antigravity session capture follows the same durable pattern as Codex, but Agy exposes the ID differently:

1. First turn runs `agy [flags] --print <prompt>` with no `--conversation` flag. Agy requires `--print` immediately before the prompt because it consumes the prompt as its flag value.
2. The bridge extracts the conversation UUID from Agy's explicit log output when available.
3. Because `--log-file` is not always honored by current Agy builds, the bridge also checks `~/.gemini/antigravity-cli/log/*.log` for recent `Created conversation ...` / `Print mode: conversation=...` lines.
4. If logs are not available, it falls back to `~/.gemini/antigravity-cli/cache/last_conversations.json` for the active working directory.
5. Later turns resume explicitly with `agy --conversation <uuid> [flags] --print <prompt>`.

**Antigravity model switching**: Agy does not expose a `--model` CLI flag. The bridge applies model selection (including capacity fallbacks) by writing the chosen model name into `~/.gemini/antigravity-cli/settings.json` before spawning the process. Resetting to the default (via `/models → Reset to Default`) removes the `model` key from that file so Agy falls back to its own default. The selected model is also persisted in the bridge's SQLite `settings` table so it survives service restarts.

**Effort switching**: Codex receives `-c model_reasoning_effort="<level>"`.
Claude receives `--effort <level>`. Agy receives no effort flag; `/effort`
shows an explicit unsupported note so the gap is intentional, not forgotten.
