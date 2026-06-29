# Development Practice — Red-Green-Refactor TDD

**All implementation work uses red-green-refactor TDD. No exceptions.**

The full TDD rules are in `CLAUDE.md`. The critical agent-specific requirements are:

## Verification — mandatory each cycle

```bash
# Step 1: write tests, then confirm they fail
npm test   # new test(s) must appear as FAILING

# Step 2: write implementation, then confirm everything passes
npm test   # all tests must PASS
```

Do not skip the red verification. If you cannot see the test failing before writing implementation, the test is not testing anything useful.

## Commit discipline — required

Tests and implementation are always **separate commits**:

```
commit 1: test: failing tests for <feature>     ← red
commit 2: feat/fix: implementation              ← green
```

Never bundle test files and production code in the same commit. This is the most common TDD failure in agent-assisted development — it produces tests-alongside-code with no verifiable red state.

## Planning requirement

When executing or reviewing a plan, every phase that adds new behaviour must include an explicit red→green step. If a plan does not call out "commit tests first, confirm red, then implement", raise it before starting that phase.

---

# Worktree and Branch Isolation

For substantial changes or complex features, use the `git-sandbox` skill to isolate execution environments. Do not modify the main workspace directly if worktree isolation is requested.

---

# Persistent memory

Bridge-spawned agents receive `AGENT_BRIDGE_CONTEXT_COMMAND` when shared
project memory is available.

Before making architectural decisions or modifying important behaviour, use:

```bash
"$AGENT_BRIDGE_CONTEXT_COMMAND" --memory-query "<short relevant query>"
```

When you learn a durable project fact, decision, bug fix, convention, or
recurring issue, write a guarded candidate with:

```bash
"$AGENT_BRIDGE_CONTEXT_COMMAND" --memory-add-json '{"type":"decision","scope":"project","text":"<concise memory>","confidence":0.8}'
```

Do not save secrets, API keys, passwords, transient logs, or private personal
information.

# Prompt optimization

The Telegram response style block in `wrapTelegramPrompt()` (`src/cli.ts`) was
produced by the standalone optimizer script. To re-run it and get a candidate
replacement block:

```bash
npx tsx scripts/optimize-prompt-loop.ts --passes 4
```

The script uses `agy --print` for all LLM calls (no API key required). Model is
whatever is active in `~/.gemini/antigravity-cli/settings.json`. The optimizer
never writes to `src/cli.ts`; it prints the winning block for manual review and
application.

Full methodology in `docs/prompt-optimization-loop-research.md`.

---

# Service Restart Safety

**Never trigger direct `sudo systemctl restart agent-bridge-<bot>` from within an active bot session.**

When a direct restart command runs inside a bot session, systemd sends SIGTERM
to the entire service control group, including the currently-running CLI
process. That kills the session issuing the restart before it can report the
result.

Approved restart paths:

1. From outside any active bot session, use direct restarts:

```bash
sudo systemctl restart agent-bridge-antigravity
sudo systemctl restart agent-bridge-codex
sudo systemctl restart agent-bridge-claude
```

2. From inside an active bot session, use the narrow safe restart helper. It
   sleeps for 5 seconds before restarting services, giving the bridge time to
   send the final Telegram reply:

```bash
sudo -n /usr/local/sbin/restart-agent-bridge
```

The helper must be root-owned and granted via a narrow sudoers rule for only
`/usr/local/sbin/restart-agent-bridge`. Do not grant `NOPASSWD: ALL` or raw
passwordless `systemctl`. Do not use the helper for destructive operations or
worker deploys that need drain semantics; worker restarts that may interrupt
active jobs still require the worker-specific drain flow.

If the bot becomes unresponsive after a bad restart, send `/reset` to the
affected bot on Telegram to clear any stale execution lock.

---

# CLI Effort Policy

Supported effort levels are `low`, `medium`, `high`, `xhigh`, and `max`;
default is `medium`. Users can change interactive bot effort with `/effort`.

- Codex: pass effort as `-c model_reasoning_effort="<level>"`
- Claude: pass effort as `--effort <level>`
- Antigravity/Agy: no separate effort CLI flag exists. Keep the setting visible
  as unsupported/no-op and use Agy model labels for low/high variants.

Worker jobs choose effort by task: scribe/read-only jobs use `medium`, while
`tdd_implementation` and `orchestrated_task` use `high`. Do not route Agy into
code-writing chains.

---

# Autonomous Worker Loop — invariants

When working on the worker lane (`src/index-worker.ts`, `src/jobExecutor*.ts`,
`src/handlers/`, `src/workspace.ts`, `src/prMergeGate.ts`, `src/workCallbacks.ts`):

- Implementation jobs run **only in per-job workspace clones** (`src/workspace.ts`),
  never in live checkouts or the worker's cwd. Workspace cleanup must stay
  restricted to `$WORKER_WORKSPACE_DIR`.
- The TDD handler enforces the red/green split mechanically: red commits stage
  test files only and the red run must fail; green commits must not touch test
  files and verification must pass. Do not weaken these guards.
- The merge gate verifies head SHA and CI checks via `gh pr view` before any
  merge. Never add a merge path that skips it. Approvals stay pending on every
  blocked path, and every Telegram callback must be answered.
- Jobs with unregistered task types fail permanently — never leave them
  pending (head-of-line blocking).
- `cancelWorkJob` is final; complete/fail must not overwrite `cancelled`.
- Child processes in the worker use the async runner (`src/runCommandAsync.ts`)
  — no `execFileSync` in the polling process.
- New job-queue Telegram output: messages go through `sendTelegramMessage`,
  message edits through the entity-converting helper in `src/workCallbacks.ts`
  (raw `**`/backticks must not reach Telegram).

User guide: `docs/WORKER-GUIDE.md`. Phase 9 plan:
`docs/autonomous-agent-bridge-research.md`.

# Health bot conventions

- The dedicated health service runs through `src/index-health.ts` with `BridgeEngine` kind `health`, but its suggestion CLI must execute through the configured agent kind (`HEALTH_SUGGEST_BOT` / `HEALTH_CLI_BOT`) so invocation, parsing, timeouts, and Telegram rendering match Codex, Antigravity, or Claude behavior.
- Manual `/health` should return one combined report only. Persist plugin reports for `/status` context with `HealthBridgeBot.handleReport(..., { force: true, silent: true })`; do not also force-send each plugin report.
- `HEALTH_SUGGEST_*` is the documented health suggestion config family. `HEALTH_CLI_*` remains a compatibility alias.
