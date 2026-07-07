# Autonomous Worker Loop — User Guide

The worker bot is a second Telegram bot that runs engineering jobs in the
background: scanning repositories for defects, planning features, implementing
approved fixes with strict TDD, running resumable orchestrated implementation
jobs, and opening draft PRs that wait for your merge approval. You talk to it on Telegram; it does the work in disposable git
workspaces and reports back at each boundary.

**The one invariant: nothing merges without your explicit approval.** The
worker can scan, plan, branch, commit, push, and open draft PRs on its own.
Merging — and anything destructive — always comes back to you.

## The Loop at a Glance

```text
/review            →  defect scan  →  proposed work items   (/issues)
/feature <brief>   →  plan drafted →  proposed work item    (/issues)
       [Approve]   →  GitHub issue + TDD implementation job
                   →  red tests → green fix → verification  (in a clone)
                   →  branch pushed → draft PR opened
                   →  merge keyboard arrives in your chat
orchestrated_task  →  plan checkpoint → execute checkpoint → verify
                   →  pr_lifecycle job → draft PR + merge gate
   [Merge PR]      →  head SHA + CI checks verified → squash merge
```

## Commands

| Command | What it does |
|---|---|
| `/review [repo]` | Queue a read-only defect scan. Defaults to `agent-bridge`. |
| `/feature <brief>` | Draft an implementation plan for a feature. Bare `/feature` captures your next message as the brief. |
| `/issues` | List proposed work items with View / Approve / Close buttons. |
| `/issue <id>` | Show one work item in detail. |
| `/jobs` | List active and pending jobs with Cancel buttons. |
| `/job <id>` | Show one job in detail (lease, attempts, errors, result). |
| `/approvals` | Re-list every pending approval with its action buttons. Use this if you lost or dismissed a merge keyboard. |
| `/models` | Show/change the active CLI model. |
| `/chain` | Show the CLI fallback chain (`codex → claude → antigravity`). |
| `/effort` | Show/change manual effort for interactive worker chat. Job effort is task-selected. |
| `/cli` | Show active CLI with switch keyboard. |

Plain messages (not commands) are routed to the CLI chain like a normal
interactive chat.

## A Typical Session

1. **`/review content-crawler`** — the worker queues a defect scan. The scan
   runs the CLI *inside* the target repo's checkout; if no local checkout
   exists for that name, the job fails loudly rather than scanning the wrong
   directory.
2. The scan posts a summary and creates proposed work items for high/medium
   confidence findings. **`/issues`** shows them.
3. Tap **Approve** on a finding. Two jobs queue: a GitHub issue is created
   first, then a TDD implementation job.
4. The implementation job **clones the repo into a disposable workspace**
   (`~/agent-bridge-workspaces/work-<id>`) — your live checkouts are never
   touched. Inside the clone it:
   - creates branch `agent/work-<id>`
   - writes failing tests, **verifies they actually fail**, commits tests only
   - implements the fix, verifies the suite passes, commits implementation only
   - enforces the split mechanically: test commits may not contain production
     files; implementation commits may not touch test files
5. The branch is pushed, a **draft PR** opens, and the merge keyboard arrives
   in your chat with the PR URL.
6. Tap **Merge PR**. Before merging, the worker verifies:
   - the PR head SHA still matches what was approved (a moved head blocks the
     merge and asks for re-review)
   - CI checks are green (failing or incomplete checks block; retry the button
     once they pass)
   Then it squash-merges and deletes the branch. **Close PR** closes without
   merging instead.

## Failure Behaviour

- `orchestrated_task` checkpoints each phase in `work_jobs.phase` and
  `phase_data_json`: planning, executing, then verifying. A successful verify
  queues `pr_lifecycle`; it does not merge directly.
- Failed jobs are retried once (`max_attempts` 2), then marked `failed`. The
  failure reason lands in your chat and in `/job <id>`.
- A failed implementation job deletes its workspace, so the retry starts from
  a clean clone — no stranded branches or dirty trees.
- Jobs whose task type has no registered handler fail immediately with a clear
  error instead of blocking the queue.
- **Cancel** on `/jobs` marks the job cancelled; a handler already running
  cannot overwrite that status afterwards.
- Long jobs heartbeat their lease while running, so a slow TDD pass is never
  claimed twice in parallel.

## Configuration

Set in the worker's env file (`.env.worker` or the systemd default file):

| Variable | Default | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN_WORKER` | — | Worker bot token (required) |
| `TELEGRAM_ALLOWED_USER_IDS` | — | Comma-separated allowed Telegram user IDs |
| `WORKER_ENABLED` | `false` | Master switch for job commands |
| `WORKER_JOB_POLL_INTERVAL_MS` | `10000` | Queue poll interval (ms) |
| `WORKER_CLI_CHAIN` | `codex,claude,antigravity` | CLI fallback order |
| `WORKER_CODE_CLI_CHAIN` | `codex,claude` | Code-writing fallback order (no Antigravity) |
| `WORKER_SCRIBE_CLI_CHAIN` | `antigravity,codex,claude` | Scribe/read-only fallback order |
| `CODEX_EFFORT` / `CLAUDE_EFFORT` / `ANTIGRAVITY_EFFORT` | `medium` | Shared effort defaults. Agy is recorded/displayed only; no CLI effort flag exists |
| `WORKER_DEFAULT_REPO` | — | Repository attached to `/feature` plans |
| `WORKER_REPO_ROOT` | `$HOME` | Where repo names resolve to local checkouts |
| `WORKER_WORKSPACE_DIR` | `~/agent-bridge-workspaces` | Per-job clone location |
| `DEFECT_SCAN_CLI_COMMAND` | `claude` | CLI used for scans/plans/implementation |
| `GITHUB_TOKEN_FILE` | `~/.secrets/GITHUB_TOKEN.TXT` | Token for `gh` API calls |
| `WORKER_MAX_OPEN_PRS` | `3` | Max simultaneous open agent PRs per repo |
| `WORKER_MAX_DAILY_PRS` | `3` | Max new agent PRs opened per UTC calendar day |
| `WORKER_PR_STALE_HOURS` | `72` | Hours of inactivity before a PR is marked stale |
| `WORKER_PR_WATCH_INTERVAL` | `3600000` | How often (ms) to enqueue a `pr_watch` job |
| `WORKER_NOTIFY_CHAT_ID` | — | Telegram chat ID for stale PR digest messages |
| `WORKER_GIT_NAME` | `agent-bridge worker` | Git author name used in workspace commits |
| `WORKER_GIT_EMAIL` | `agent-bridge-worker@users.noreply.github.com` | Git author email used in workspace commits |
| `DB_PATH` | `.data/bridge.sqlite` | SQLite database path |
| `BRIDGE_EXECUTION_MODE` | `safe` | Execution mode (`safe` or `trusted`) |
| `PR_DEFECT_SCAN_ENABLED` | `false` | Enable pre-merge defect scanning when CI checks pass |


Code-writing jobs (`tdd_implementation`, `orchestrated_task`) use the code
chain and never fall back to Agy. Scribe/read-only jobs (`defect_scan`,
`feature_plan`, summaries, PR/doc prose) use the scribe chain, which defaults
to Agy first to conserve Codex/Claude coding capacity.

Worker effort is selected by task type. Scribe/read-only jobs use `medium`;
code-writing jobs use `high`. Codex maps effort to `model_reasoning_effort`,
Claude maps effort to `--effort`, and Agy effort is an explicit no-op because
the Agy CLI exposes low/high choices through model labels instead.

Repository names resolve to `$WORKER_REPO_ROOT/<name>` (the part after `/` for
`owner/name` forms). The directory must be a git checkout; workspaces clone
from it and repoint `origin` at its real remote so pushes reach GitHub.

## Troubleshooting

- **Approve did nothing?** `/jobs` shows the queued jobs and their errors;
  `/job <id>` has the full failure reason.
- **Lost the merge keyboard?** `/approvals` re-lists every pending approval
  with its buttons.
- **Merge button blocked?** The message says why — head moved (re-review) or
  checks not green (wait and retry). The approval stays pending.
- **Job stuck?** Leases expire (5 min standard, 30 min for plans and TDD jobs)
  and are reclaimed automatically; `/job <id>` shows lease owner and expiry.
- Logs: `journalctl --user -u agent-bridge-worker-bot` (or system unit,
  depending on install). Job state lives in the worker's SQLite DB
  (`work_items`, `work_jobs`, `approvals`, `github_links`).

## What It Will Not Do

- Merge, force-push, delete branches outside merge, or run destructive git
  operations without an explicit approval.
- Push to `main` directly — all work goes through agent branches and PRs.
- Operate in your live checkouts — implementation work happens in clones.
- Treat its own defect reports as confirmed bugs: findings are proposals
  until you approve them.

## PR Lifecycle Controls

The Phase 9 PR lifecycle controls are implemented in the worker lane:

- `pr_lifecycle` reuses an existing agent PR for the same branch instead of
  creating duplicates on retry.
- `WORKER_MAX_OPEN_PRS` and `WORKER_MAX_DAILY_PRS` cap new agent PR creation
  while still allowing existing PRs to be refreshed.
- `pr_watch` runs on the configured interval, checks CI and merge readiness,
  marks stale PRs, and refreshes merge approvals with the current head SHA.
- stale PRs are batched into a digest with hold, refresh, close, and release
  decisions.
- `pr_refresh` merges the base branch into the PR branch in a disposable
  workspace, runs verification, and pushes only on success.
- merge approval messages include an owner decision brief and proof comment
  data so the user is not asked to approve from a bare URL.

The remaining roadmap is maintainer queue triage: turning external issue/PR
queues into the same policy-gated worker flow. Plan:
`docs/autonomous-agent-bridge-research.md` → "Phase 9.5 — Maintainer Queue
Triage".

## Git Worktree Sandboxing

For substantial or complex changes, the worker can use the `git-sandbox` skill to isolate its execution environment. This avoids writing changes directly into the main workspace. The sandbox workflow:
1. Creates a feature branch and isolates the workspace using `git worktree`.
2. Commits tests first (TDD mode) to verify failure.
3. Implements the fix, verifies all checks pass, and commits the implementation.
4. Opens a Draft Pull Request using the GitHub CLI (`gh pr create --draft`).
5. Cleans up the local worktree after merge or close.

## Prompt Customization Templates

The worker supports dynamic database-backed prompt customization templates. If a template exists in the SQLite `prompts` table, the worker loads it instead of the hardcoded default prompt.

### DB Schema
The templates are stored in the `prompts` table:
```sql
CREATE TABLE prompts (
  name        TEXT    PRIMARY KEY,
  prompt_text TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### Overridable Prompt Names and Placeholders

| Prompt Name | Handled In | Purpose | Placeholders |
|---|---|---|---|
| `defect_scan:triage` | `defectScan.ts` | Triaging scan findings | `{repository}`, `{findings}` |
| `feature_plan` | `featurePlan.ts` | Feature plan generation | `{brief}` (or `${brief}`) |
| `refactor_scan:scan` | `refactorScan.ts` | Running refactoring scan | `{repository}` (or `${repository}`) |
| `refactor_scan:plan` | `refactorScan.ts` | TDD plan for refactor finding | `{repository}`, `{title}`, `{rationale}`, `{files}`, `{impact_score}`, `{effort_score}` |
| `tdd_implementation:ci_fix` | `tddImplementation.ts` | Fixing failing CI checks | `{title}`, `{body}`, `{ciSummary}`, `{ciLog}` |
| `tdd_implementation:repair` | `tddImplementation.ts` | Fixing implementation compile/run errors | `{title}`, `{body}`, `{priorError}` |
| `tdd_implementation:red_test` | `tddImplementation.ts` | Writing failing TDD tests | `{title}`, `{body}` |
| `tdd_implementation:green_implementation` | `tddImplementation.ts` | Implementing the fix | `{title}`, `{body}` |

### Setting a Template Customization
You can inject a customized prompt directly into the SQLite DB:
```bash
sqlite3 .data/bridge.sqlite "INSERT OR REPLACE INTO prompts (name, prompt_text) VALUES ('feature_plan', 'My custom feature plan template: {brief}');"
```

