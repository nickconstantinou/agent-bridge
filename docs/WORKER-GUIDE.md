# Autonomous Worker Loop — User Guide

The worker bot is a second Telegram bot that runs engineering jobs in the
background: scanning repositories for defects, planning features, implementing
approved fixes with strict TDD, and opening draft PRs that wait for your merge
approval. You talk to it on Telegram; it does the work in disposable git
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
| `/models` | Show the CLI fallback chain (`codex → claude → antigravity`). |

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
   (`~/.agent-bridge/workspaces/work-<id>`) — your live checkouts are never
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
| `WORKER_ENABLED` | `false` | Master switch for job commands |
| `WORKER_JOB_POLL_INTERVAL_MS` | `10000` | Queue poll interval (ms) |
| `WORKER_CLI_CHAIN` | `codex,claude,antigravity` | CLI fallback order |
| `WORKER_DEFAULT_REPO` | — | Repository attached to `/feature` plans |
| `WORKER_REPO_ROOT` | `$HOME` | Where repo names resolve to local checkouts |
| `WORKER_WORKSPACE_DIR` | `~/.agent-bridge/workspaces` | Per-job clone location |
| `DEFECT_SCAN_CLI_COMMAND` | `claude` | CLI used for scans/plans/implementation |
| `GITHUB_TOKEN_FILE` | `~/.secrets/GITHUB_TOKEN.TXT` | Token for `gh` API calls |
| `WORKER_MAX_OPEN_PRS` | `3` | Max simultaneous open agent PRs per repo |
| `WORKER_MAX_DAILY_PRS` | `3` | Max new agent PRs opened per UTC calendar day |
| `WORKER_PR_STALE_HOURS` | `72` | Hours of inactivity before a PR is marked stale |
| `WORKER_PR_WATCH_INTERVAL` | `3600000` | How often (ms) to enqueue a `pr_watch` job |
| `WORKER_NOTIFY_CHAT_ID` | — | Telegram chat ID for stale PR digest messages |
| `WORKER_GIT_NAME` | `agent-bridge worker` | Git author name used in workspace commits |
| `WORKER_GIT_EMAIL` | `agent-bridge-worker@...` | Git author email used in workspace commits |

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
