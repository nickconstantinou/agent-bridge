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
