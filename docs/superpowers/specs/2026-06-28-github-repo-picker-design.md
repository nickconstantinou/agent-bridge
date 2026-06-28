# GitHub Repo Picker Design

**Date:** 2026-06-28  
**Status:** Approved (revised)

## Problem

- `nickconstantinou` hardcoded in 3 handler files.
- When no repo is set, commands that need one fail with a text error requiring re-type or env config.
- No way to dynamically discover which repos are available.
- Worker job failures surface raw error strings to Telegram — user should not see transient failures.
- Installer has no worker section; `GITHUB_USERNAME` and `WORKER_DEFAULT_REPO` are never prompted.
- No `/refactor` command exists.

## Solution

1. `GITHUB_USERNAME` env var replaces hardcoded username.
2. New `src/repoRegistry.ts` fetches repos via `gh api /user/repos`, cached 5 min.
3. Inline keyboard repo picker shown at **command/brief time** when no repo is resolved.
4. `/refactor` added as a new worker command (like `/review` but scoped to code quality).
5. Orchestrator swallows transient job failures silently; only surfaces permanent failures with a clean summary.
6. Installer prompts for `GITHUB_USERNAME`, `WORKER_DEFAULT_REPO`, and `WORKER_ENABLED`.

## Env Var

`GITHUB_USERNAME` — set in `.env.worker` (and `.env.worker.example`). Used as the default owner prefix when a bare repo name is given. No fallback; missing value throws a clear error at call site.

## Where the Picker Appears

| Trigger | When shown |
|---|---|
| `/review` | No arg and no `WORKER_DEFAULT_REPO` — shown inline before work item is created |
| `/feature <brief>` | No default repo — shown immediately after brief is captured |
| `/refactor <brief>` | Same as `/feature` |

Picker does **not** appear on work item detail view — that would require setting repo on each item individually.

## Callback Format (≤64 bytes)

```
rs:<name>:r        Run defect scan on repo <name>
rs:<name>:rf       Run refactor scan on repo <name>
rs:<name>:f        Set repo for pending feature brief and queue feature_plan job
```

Repo names are GitHub short names (no owner prefix). Max safe name length: ~50 chars.

## Architecture

### `src/repoRegistry.ts` (new)

- `fetchUserRepos()` — calls `gh api /user/repos?per_page=50&sort=updated`, caches 5 min. Returns `Array<{name: string, full_name: string}>`.
- `buildRepoKeyboard(ctx: string)` — returns `{inline_keyboard: ...}` with `rs:<name>:<ctx>` buttons, 2 per row.
- `parseRepoSelectCallback(data: string)` — returns `{repo: string, ctx: string} | null` for `rs:` prefixed data.
- `resolveGithubOwner()` — returns `process.env.GITHUB_USERNAME` or throws with a clear message.

### `src/workerBot.ts`

- `/review` no-repo path: returns `keyboard_message` with `buildRepoKeyboard('r')` instead of text error.
- `/refactor [repo]` (new command): same routing as `/review` but queues `refactor_scan` task type. No repo → `buildRepoKeyboard('rf')`.
- `/feature <brief>` or captured brief: if no default repo, store brief in `pendingBriefs` map keyed by chatId, return `keyboard_message` with `buildRepoKeyboard('f')`.
- Handler becomes async where repo registry is called.

### `src/workCallbacks.ts`

Handles new callback types via `parseRepoSelectCallback`:
- `rs:<name>:r` → create `defect_scan` job for `<name>`, answer callback with confirmation.
- `rs:<name>:rf` → create `refactor_scan` job for `<name>`, answer callback.
- `rs:<name>:f` → consume pending brief for this chat, create `feature_plan` work item with `repository = owner/<name>`, answer callback.

### `src/jobExecutorLoop.ts` — Orchestrator silence

Current: every failure calls `notify(...)`, surfacing raw errors.  
Change: transient failures (retry attempts remaining) → log only, no Telegram notification. Permanent failures (max attempts exhausted or `failedPermanently`) → notify with a clean one-line summary using `sanitizeWorkerNotification`.

Repair job queuing notification is also silenced — orchestrator queues repair autonomously without messaging the user.

### Handler files

`githubIssue.ts`, `prLifecycle.ts`, `prWatch.ts`: replace `'nickconstantinou'` literal with `resolveGithubOwner()` from repoRegistry.

### `scripts/install.sh`

Add a worker section after the existing prompts:
```
prompt TELEGRAM_BOT_TOKEN_WORKER  "Worker bot token (leave blank to skip)"  ""
prompt GITHUB_USERNAME            "GitHub username for worker repos"         ""
prompt WORKER_DEFAULT_REPO        "Default repo for worker scans (short name)" ""
prompt WORKER_ENABLED             "Enable worker bot (true|false)"           "false"
```
Write into `.env.worker` (separate file, created only when token is non-blank).

## Error Handling

- `fetchUserRepos()` failure → log warning, return text error ("Could not fetch repos — try `/review <repo>`")
- No repos returned → show text message, not empty keyboard
- `GITHUB_USERNAME` unset → `resolveGithubOwner()` throws; caller catches and surfaces to user
- Pending brief consumed by repo selection; if no brief found, answer callback with "No pending feature — use /feature first"

## Testing

- Unit tests for `parseRepoSelectCallback`, `resolveGithubOwner`
- Unit tests for keyboard building (shape, button text, callback format)
- Unit tests for orchestrator silence: transient failure → no notify call; permanent failure → notify called once with sanitized message
- Integration tests for each new callback branch in `workCallbacks.ts`
- `/review` and `/refactor` tests cover no-repo keyboard path
- `/feature` brief-then-repo-select flow tested end-to-end
