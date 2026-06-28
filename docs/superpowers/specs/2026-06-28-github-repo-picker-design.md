# GitHub Repo Picker Design

**Date:** 2026-06-28  
**Status:** Approved

## Problem

- `nickconstantinou` hardcoded in 3 handler files.
- When no repo is set, commands that need one (`/review`, `/feature`) fail with a text error. User must re-type with an arg or set `WORKER_DEFAULT_REPO`.
- No way to dynamically discover which repos are available.

## Solution

1. `GITHUB_USERNAME` env var replaces hardcoded username.
2. New `src/repoRegistry.ts` fetches repos via `gh api /user/repos`, cached 5 min.
3. Inline keyboard repo picker shown whenever a command needs a repo but none is resolved.

## Env Var

`GITHUB_USERNAME` — set in `.env.worker` (and `.env.worker.example`). Used as the default owner prefix when a bare repo name is given. No fallback default; missing value throws a clear error at call site.

## Where the Picker Appears

| Trigger | When shown |
|---|---|
| `/review` | No arg and no `WORKER_DEFAULT_REPO` |
| `/feature` | Work item has no repo (shown in work item detail view as "Set Repo" button) |
| Future `/refactor` | Same pattern — `repoRegistry.buildRepoKeyboard()` is reusable |

## Callback Format (≤64 bytes)

```
rs:show:w<id>      Show repo keyboard for work item <id>
rs:<name>:r        Run defect scan on repo <name>
rs:<name>:w<id>    Assign repo <name> to work item <id>
```

Repo names are GitHub short names (no owner prefix). Max safe name length: ~45 chars.

## Architecture

### `src/repoRegistry.ts` (new)

- `fetchUserRepos()` — calls `gh api /user/repos?per_page=50`, caches 5 min in-process. Returns `Array<{name: string, full_name: string}>` sorted by `updated_at` desc.
- `buildRepoKeyboard(ctx: string)` — returns `{inline_keyboard: ...}` with `rs:<name>:<ctx>` buttons, 2 per row.
- `parseRepoSelectCallback(data: string)` — returns `{repo: string, ctx: string} | null` for `rs:` prefixed data.
- `resolveGithubOwner()` — returns `process.env.GITHUB_USERNAME` or throws with a clear message.

### `src/workerBot.ts`

`/review` no-repo path: returns `keyboard_message` with `buildRepoKeyboard('r')` instead of text error. Requires `async` handling (registry fetch is async) — workerBot command handler becomes async.

### `src/workCallbacks.ts`

Handles 3 new callback types via `parseRepoSelectCallback`:
- `rs:show:w<id>` → edit message to show repo keyboard (with back button if feasible)
- `rs:<name>:r` → create defect_scan job for `<name>`, answer callback
- `rs:<name>:w<id>` → update work item repo, edit message back to work item detail view

Work item detail view: when `item.repository` is null, adds a "📂 Set Repo" button (callback `rs:show:w<id>`).

### Handler files

`githubIssue.ts`, `prLifecycle.ts`, `prWatch.ts`: replace `'nickconstantinou'` literal with `resolveGithubOwner()` from repoRegistry.

## Error Handling

- `fetchUserRepos()` failure → log warning, show text error ("Could not fetch repos — try `/review <repo>`")
- No repos returned → show text message, not empty keyboard
- `GITHUB_USERNAME` unset → `resolveGithubOwner()` throws; caller catches and surfaces to user

## Testing

- Unit tests for `parseRepoSelectCallback`, `resolveGithubOwner`
- Unit tests for keyboard building (shape, button text, callback format)
- Integration tests for each new callback branch in `workCallbacks.ts`
- Existing `/review` tests updated to cover no-repo keyboard path
