# Autonomous Agent Bridge Research

## Status

**Phases 0–4 complete. Phase 5 in progress.** Both new bots are deployed and running. The SQLite schema, lease lifecycle, Telegram commands, callback handling, job executor loop, and defect scan handler are fully implemented and tested. `/review` now queues real defect_scan jobs that execute via the CLI and create proposed work_items.

| Phase | Status |
|---|---|
| Phase 0 — bot infrastructure | ✅ Complete |
| Phase 1 — durable work schema | ✅ Complete |
| Phase 2 — job lease lifecycle | ✅ Complete |
| Phase 3 — Telegram job commands | ✅ Complete |
| Phase 4 — read-only defect scan | ✅ Complete |
| Phase 5 — feature planning loop | 🔄 In progress |
| Phase 6 — GitHub issue creation | Not started |
| Phase 7 — TDD implementation job | Not started |
| Phase 8 — PR lifecycle + merge gate | Not started |

This note reviews the proposed Agent Bridge evolution from a Telegram-driven CLI wrapper into an asynchronous, policy-gated engineering agent. It is intentionally specific enough for a later implementation agent to use, but it should be treated as a design document until each phase is converted into red-green-refactor work.

## Executive Summary

Agent Bridge is currently a thin Telegram control surface over Codex, Antigravity, and Claude CLI processes. That shape has served the project well: Telegram remains responsive, process lifecycle is visible, and the bridge does not pretend to be the agent.

The proposed next step is not to replace that model. The safer path is to add a second execution lane:

```text
Interactive lane:
Telegram message -> BridgeEngine -> CLI process -> Telegram response

Autonomous lane:
Telegram command / schedule -> durable work item -> worker lease -> CLI process -> issue/PR/artifact -> merge approval
```

The strategic goal is a semi-autonomous engineering loop that can inspect repositories, draft issues, prepare plans, and implement approved work while preserving one hard invariant:

**The human authorizes policy and final merge; the agent may operate inside that policy without asking at every step.**

The final merge is the main human gate. Additional approval is required only for actions outside the standing policy, such as service restarts, production deploys, destructive Git operations, permission changes, or work in a repository that has not been allowlisted.

## Review Of The Proposed Blueprint

The proposal is directionally strong:

- The split-loop pattern is the right way to avoid hanging Telegram polling while long-running work continues.
- SQLite is an appropriate first durable queue because the bridge already depends on synchronous SQLite and runs on one host.
- The three-loop model maps cleanly to real engineering workflows: detect defects, plan features, resolve approved work.
- Telegram inline approvals are a good control surface for merge decisions, exceptions, and policy changes because they give the user low-friction authorization without opening another UI.

The proposal needs tightening before implementation:

- `agent_issues.issue_number` cannot be the primary internal identifier because not every proposed item should become a GitHub issue immediately, and GitHub issue numbers are only unique per repository.
- `job_queue.issue_number NOT NULL` is too restrictive. Defect scans, research jobs, health analysis, and feature planning may run before an issue exists.
- The schema needs leases and heartbeats, otherwise a worker crash can leave a job stuck in `processing`.
- Approval state must be separate from job state. A job can complete a PR and wait for merge approval; that is not a failed engineering outcome.
- GitHub writes need explicit idempotency keys and audit records to prevent duplicate issues or PRs after retries.
- The worker must run through the existing CLI invocation, parser, timeout, event, and Telegram rendering paths where possible. A second ad hoc CLI runner would duplicate the hardest operational code in the bridge.
- The plan must use the existing event persistence work as a foundation, not create an unrelated lifecycle model.

## Non-Goals

The first implementation should not:

- Add a web dashboard.
- Replace Telegram as the final merge and exception-approval surface.
- Give the worker permission to merge PRs without a Telegram merge approval.
- Run arbitrary scheduled code changes without human approval.
- Add a distributed queue or broker.
- Store full token streams permanently.
- Rewrite the existing interactive `BridgeEngine`.
- Auto-create GitHub issues for every scan finding without confidence thresholds, caps, deduplication, and labels.
- Treat LLM-generated defect reports as confirmed bugs without local evidence.

## Architectural Principle

The bridge should become an orchestrator of durable work, not an unbounded autonomous actor.

Every background loop should have the same shape:

```text
observe -> draft -> execute within policy -> report -> prepare merge -> ask once
```

The agent should not ask for approval at every source-control step. Once a repository and workflow policy are enabled, normal issue creation, branch creation, commits, pushes, PR creation, PR refreshes, and CI-fix iterations can proceed autonomously within caps. Merge remains the final gate.

## Proposed System Shape

```text
                          ┌──────────────────────┐
                          │      Telegram         │
                          │ commands + approvals  │
                          └──────────┬───────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────┐
│                    Agent Bridge SQLite                      │
│                                                             │
│ bridge_state  bridge_runs  bridge_events                    │
│ work_items    work_jobs    approvals    github_links         │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
                 ┌──────────────────────┐
                 │ Background Worker     │
                 │ lease/poll/execute    │
                 └──────────┬───────────┘
                            │
             ┌──────────────┼──────────────┐
             ▼              ▼              ▼
        local repo      CLI agents      GitHub API
       read/write      Codex/Agy/Claude issue/PR sync
```

The Telegram bot remains the responsive control plane. The worker is a separate process or service that:

1. Claims one pending job by lease.
2. Executes within an explicit workspace.
3. Emits bridge events.
4. Writes artifacts and outcome records.
5. Posts concise Telegram updates at workflow boundaries.
6. Requests approval only for final merge or policy exceptions.

## Minimum Approval Model

The workflow should be manageable. A useful autonomous engineering agent cannot pause for approval at every routine step. The approval model should therefore distinguish between standing policy and exception gates.

### Standing Policy

The user configures or approves a standing policy per repository:

- allowed repositories
- allowed bot kind/model preference
- allowed task types
- max open agent PRs per repository
- max daily new PRs
- max retry/refresh attempts per PR
- allowed labels
- allowed branch prefix, for example `agent/work-`
- allowed commands for verification
- whether defect scans may create issues automatically
- whether feature plans may create draft issues automatically

Once this policy is enabled, the agent can perform normal work inside those limits without asking.

### No Approval Needed Inside Policy

These actions should not require per-step approval when the work item is inside policy:

- create a local work item
- create a GitHub issue with `agent-proposed` / `agent-working` labels
- create an isolated branch
- write red tests
- commit red tests
- implement green change
- commit implementation
- run verification
- push the agent branch
- create a draft PR
- update an existing agent PR
- re-run verification
- rebase or refresh an agent branch if the operation is non-destructive
- mark a PR stale
- close a duplicate local work item

The agent should still report these actions in summaries and persistent job state.

### Approval Required

Approval is required for:

- merging a PR
- closing a GitHub PR as abandoned if it contains non-trivial work
- deleting a branch
- force-pushing
- destructive Git operations
- service restarts
- production deploys
- secret/config changes
- permission changes
- actions outside an allowlisted repository
- exceeding PR caps
- changing the standing policy

### Final Merge Gate

The final merge approval should be the main human decision point.

Before asking for merge, the agent must provide:

- PR title and URL
- work item / issue id
- files changed summary
- red test commit
- green implementation commit
- verification commands and results
- CI status
- stale/refresh history
- risk notes
- rollback note

Telegram buttons:

```text
[Merge PR] [Refresh] [Hold] [Close PR]
```

`Merge PR` is the only routine approval needed for normal code work.

### PR Lifecycle Management

To avoid stale PR buildup, the worker needs an active PR lifecycle loop.

States:

```text
draft -> ready_for_ci -> ci_failed -> refreshing -> ready_to_merge
ready_to_merge -> merge_requested -> merged
ready_to_merge -> held
ci_failed -> needs_human
refreshing -> stale
stale -> closed | refreshed | held
```

Rules:

- cap open agent PRs per repository, default `3`
- cap new agent PRs per day, default `3`
- prefer updating an existing PR over opening a new one
- if CI fails, create one auto-fix job within retry limits
- if the PR is behind base, refresh it automatically within retry limits
- if a PR has no activity for the stale threshold, send a Telegram digest, not a stream of individual alerts
- if a PR remains stale after the hold threshold, request one decision: refresh, close, or hold
- merged PRs should close their linked work item
- closed PRs should mark linked jobs/work items with the closure reason

PR hygiene labels:

```text
agent-pr
agent-working
agent-ready
agent-refreshing
agent-stale
needs-human
```

This keeps GitHub from becoming the queue. SQLite remains the queue; GitHub PRs are deliverables waiting for final review.

## Domain Model

Use neutral terms for internal state. A proposed defect, feature idea, or research question is a work item. A scheduled attempt to do something is a job. A GitHub issue is an optional external projection of a work item.

### `work_items`

```sql
CREATE TABLE work_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  kind              TEXT NOT NULL CHECK (kind IN (
                      'defect',
                      'feature',
                      'maintenance',
                      'research',
                      'ops'
                    )),
  source            TEXT NOT NULL CHECK (source IN (
                      'telegram',
                      'health',
                      'defect_scan',
                      'schedule',
                      'github',
                      'manual'
                    )),
  repository        TEXT,
  title             TEXT NOT NULL,
  body              TEXT,
  status            TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
                      'proposed',
                      'needs_approval',
                      'approved',
                      'in_progress',
                      'blocked',
                      'resolved',
                      'closed',
                      'rejected'
                    )),
  priority          TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN (
                      'low',
                      'normal',
                      'high',
                      'urgent'
                    )),
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### `work_jobs`

```sql
CREATE TABLE work_jobs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id      INTEGER,
  task_type         TEXT NOT NULL CHECK (task_type IN (
                      'defect_scan',
                      'feature_research',
                      'implementation_plan',
                      'run_tdd_fix',
                      'open_github_issue',
                      'open_pull_request',
                      'verify_pull_request',
                      'ops_check'
                    )),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                      'pending',
                      'leased',
                      'running',
                      'waiting_approval',
                      'completed',
                      'failed',
                      'cancelled'
                    )),
  bot               TEXT CHECK (bot IN ('codex', 'antigravity', 'claude')),
  lease_owner       TEXT,
  lease_expires_at  TEXT,
  heartbeat_at      TEXT,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 2,
  idempotency_key   TEXT NOT NULL UNIQUE,
  input_json        TEXT NOT NULL DEFAULT '{}',
  result_json       TEXT,
  error             TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(work_item_id) REFERENCES work_items(id)
);
```

`work_item_id` is nullable so repository scans and ops checks can run before a concrete issue exists.

### `approvals`

```sql
CREATE TABLE approvals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id      INTEGER,
  job_id            INTEGER,
  approval_type     TEXT NOT NULL CHECK (approval_type IN (
                      'create_issue',
                      'start_implementation',
                      'push_branch',
                      'open_pr',
                      'merge_pr',
                      'restart_service',
                      'cancel_job'
                    )),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                      'pending',
                      'approved',
                      'rejected',
                      'expired'
                    )),
  requested_by      TEXT NOT NULL,
  requested_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_by        TEXT,
  decided_at        TEXT,
  expires_at        TEXT,
  payload_json      TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(work_item_id) REFERENCES work_items(id),
  FOREIGN KEY(job_id) REFERENCES work_jobs(id)
);
```

### `github_links`

```sql
CREATE TABLE github_links (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id      INTEGER NOT NULL,
  repository        TEXT NOT NULL,
  issue_number      INTEGER,
  pr_number         INTEGER,
  branch_name       TEXT,
  commit_sha        TEXT,
  remote_url        TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(repository, issue_number),
  UNIQUE(repository, pr_number),
  FOREIGN KEY(work_item_id) REFERENCES work_items(id)
);
```

This avoids overloading the internal work item identity with GitHub issue numbers.

### `feature_plans`

```sql
CREATE TABLE feature_plans (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN (
               'drafting',
               'ready',
               'accepted',
               'cancelled',
               'expired'
             )),
  brief      TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Used by the feature planning state machine (Slice 9). Keyed by `(chat_id, user_id)` for an active draft. Survives restarts. Stale rows with status `drafting` can be expired by the worker on startup.

## Worker Execution Model

The worker should be boring:

1. Poll for one pending job ordered by priority and age.
2. Claim it with a lease:

```sql
UPDATE work_jobs
SET status = 'leased',
    lease_owner = ?,
    lease_expires_at = ?,
    updated_at = CURRENT_TIMESTAMP
WHERE id = ?
  AND status = 'pending'
  AND (lease_expires_at IS NULL OR lease_expires_at < CURRENT_TIMESTAMP);
```

3. Transition to `running`.
4. Execute through the existing bridge CLI path or a thin worker wrapper around the same `runCliAsync` primitives.
5. Emit `bridge_runs` / `bridge_events` records for the run.
6. Store result artifacts in `result_json`.
7. Transition to `completed`, `failed`, or `waiting_approval`.
8. Send a compact Telegram update.

Lease recovery:

- A job with expired `lease_expires_at` can be reclaimed.
- A worker updates `heartbeat_at` while a CLI child is alive.
- On service startup, jobs stuck in `leased` or `running` with expired leases become `pending` if attempts remain, otherwise `failed`.
- The worker systemd unit must use `KillMode=control-group` (consistent with the existing bridge units) so that a restart terminates any in-flight CLI child before the new worker instance starts. Without this, a restarting worker can claim a job that the previous worker's CLI child is still executing, causing duplicate work. Startup recovery handles the lease left by the killed process.

Cancellation:

- `/jobs` should show active jobs.
- `/cancel_job <id>` or an inline button should request cancellation.
- Cancellation should reuse the existing active process abort semantics where possible.

## Skill 1: Defect Identification

Purpose: find high-probability defects without changing code.

Triggers:

- `/review`
- `/scan repo`
- scheduled nightly scan
- health plugin escalation

Inputs:

- repository path
- changed files since a baseline
- recent failing tests or health alerts
- recent GitHub issues / PRs if available

Analysis steps:

1. Repository skeletonization:
   - file tree excluding generated and dependency directories
   - package scripts
   - TypeScript public interfaces
   - service units
   - migration files
   - test layout

2. Evidence collection:
   - `git status --short`
   - latest commits
   - 90-day churn ranking
   - relevant logs if the task is operational
   - test failures if already present
   - health reports
   - static type-check output
   - lint output when a lint command exists

3. Churn and forensic discovery:
   - run a bounded Git churn query over the last 90 days
   - use `git log --since="90 days ago" --format=format: --name-only`
   - filter blank lines, sort paths, count frequency, and keep the top candidates
   - exclude generated files, vendored files, build outputs, lockfiles, and large data artifacts
   - store churn results in the job result payload so the Telegram summary can explain why a file was inspected

   Example command shape:

   ```bash
   git log --since="90 days ago" --format=format: --name-only \
     | rg -v '(^$|node_modules|dist|build|coverage|package-lock.json)' \
     | sort \
     | uniq -c \
     | sort -rg \
     | head -10
   ```

4. Targeted inspection:
   - cross-reference high-churn files with `npm run typecheck` or `tsc --noEmit`
   - cross-reference high-churn files with lint output if the repo exposes a lint script
   - prioritize files that are both high-churn and near static analysis warnings/errors
   - if typecheck/lint fails globally, classify whether the failure is related to the churn target before creating a finding

5. Defect hypothesis drafting:
   - title
   - impact
   - evidence
   - suspected files
   - reproduction command
   - confidence
   - suggested red test
   - related churn/static-analysis evidence
   - proposed GitHub issue labels such as `agent-proposed`, `bug`, `needs-triage`

6. Issue compilation:
   - group related discrepancies into a single proposed issue when they share a root cause
   - generate a structured GitHub issue payload locally
   - create or update a local `work_item`
   - create the GitHub issue automatically when repository policy permits it; otherwise queue a policy-exception approval

7. Telegram review:
   - show top findings only
   - button: `Create issue`
   - button: `Dismiss`
   - button: `Run focused verification`

Autonomous limit:

- The scan can create local proposed `work_items`.
- It can create GitHub issues automatically only when the repository policy permits issue creation and confidence/deduplication checks pass.

Output:

- proposed `work_items`
- optional `open_github_issue` jobs gated by repository policy

## Skill 2: Feature Ingestion And Planning

Purpose: turn Telegram discussion into implementation-ready plans before any feature code is written.

Triggers:

- `/feature <brief>`
- `/plan`
- natural-language request followed by `make a plan`
- promoted research artifact

Steps:

1. Capture the user request and constraints.
2. Ask concise follow-up questions only when required to remove implementation ambiguity.
3. Inspect relevant repo context.
4. Identify assumptions and non-goals.
5. Produce acceptance criteria.
6. Produce a standardized Markdown implementation plan.
7. Create or update a GitHub issue automatically when policy permits it; otherwise request policy-exception approval.

Required plan sections:

1. Target footprint:
   - explicit files to create
   - explicit files likely to modify
   - ownership boundaries that should not be touched

2. Red test specification:
   - exact test file path
   - test framework command
   - assertion that must fail before implementation
   - expected failure reason

3. State and schema alterations:
   - database migrations
   - SQLite schema changes
   - interface/type boundary changes
   - systemd/config/env changes
   - rollback notes

4. Implementation phases:
   - each behavior-changing phase must include red test, green change, verification, and commit split

Policy behavior:

- accepted plans can create a GitHub issue automatically when policy permits it
- accepted plans can insert a corresponding pending `run_tdd_fix` or `feature_research` job
- issue creation and job insertion should be idempotent
- if the plan exceeds policy, request one exception approval rather than asking at each later step

Output:

- research document or issue body
- proposed work item
- optional GitHub issue payload
- queued next action or policy-exception approval request

## Skill 3: Issue Resolution

Purpose: resolve approved GitHub or local work items through strict TDD.

Triggers:

- Telegram approval on a proposed defect
- `/work <issue>`
- approved GitHub issue label, if label sync is later implemented

Required sequence:

1. Create or select an isolated branch.
2. Understand the issue and repo context.
3. Write focused failing tests.
4. Run tests and confirm the new tests fail.
5. Commit tests only:

```text
test: failing coverage for <issue>
```

6. Implement the smallest change.
7. Run full relevant verification.
8. Commit implementation only:

```text
fix: resolve <issue>
```

9. Prepare PR summary.
10. Push branch and open or update a draft PR when policy permits it.
11. Keep the PR fresh until it is ready for the final merge gate.
12. Ask for merge approval only after tests and CI are green, or ask for a hold/close decision when the PR is stale.

Hard rule:

- Test and implementation commits stay separate. This mirrors the project `AGENTS.md` TDD requirement and must be enforced by the worker plan prompt.

Worker guardrails:

- Refuse to start if the target repo has unrelated dirty files unless the approval payload explicitly allows working with them.
- Never run destructive Git commands such as `git reset --hard` or `git checkout --` without explicit approval.
- Never merge PRs without Telegram merge approval.
- Never push directly to `main`.

Output:

- branch name
- commits
- PR draft or PR URL
- verification summary
- merge approval request when ready

## Telegram Control Surface

Initial commands:

```text
/jobs
/job <id>
/issues
/issue <work_item_id>
/prs
/pr <id>
/approve <approval_id>
/reject <approval_id>
/review
/feature <brief>
/plan
/work <work_item_id>
/cancel_job <job_id>
```

Inline buttons should be preferred for approvals because they reduce typing errors:

- `Read body`
- `Start TDD fix`
- `Merge PR`
- `Refresh PR`
- `Hold PR`
- `Close PR`
- `Cancel job`
- `Dismiss`

Telegram messages should include:

- job id
- work item id
- repository
- current state
- next required action
- short verification result

Avoid dumping full logs into Telegram. Store logs/artifacts locally and summarize.

### Issue List Flow

`/issues` should show proposed and approval-waiting `work_items`, not raw GitHub issues only. The detail view should include:

```text
Issue #104: Fix SQLite connection pool leak
Source: Defect Scan
Priority: High
Status: proposed

[Read Body] [Approve] [Close]
```

Button actions:

- `Read Body` replaces the message with the full proposed issue body and a `Back` button.
- `Start` updates local work item state, then enqueues the next job.
- `Close` marks the local work item rejected or closed. If a GitHub issue already exists, closure follows the repository policy; non-trivial PR closure should use the PR lifecycle decision flow.

### Callback Payloads

Telegram callback data is limited to 64 bytes. Keep payloads compact and stable.

Recommended format:

```text
wi:<id>:view
wi:<id>:appv
wi:<id>:clse
job:<id>:cncl
ap:<id>:yes
ap:<id>:no
```

Rules:

- callback payloads reference database IDs only
- never put prompt text, issue body, commands, file paths, or secrets in callback data
- load the full action payload from SQLite
- validate the approving Telegram user before changing state
- make callbacks idempotent so repeated taps do not duplicate jobs, issues, or PRs

The proposed `iss:104:appv` style is acceptable only if `104` is the local `work_items.id` or approval id. It should not assume GitHub issue numbers are globally unique.

## GitHub Integration

GitHub should be treated as an external projection of local work state, not the queue itself.

Recommended mapping:

- local `work_item` proposed by scan or plan
- policy creates GitHub issue or keeps work local
- `github_links` records issue number
- policy starts implementation job
- implementation job creates branch locally
- implementation job pushes branch and opens or updates draft PR when policy permits it
- `github_links` records PR number and branch
- PR lifecycle loop keeps the PR fresh
- Telegram merge approval completes the work

Idempotency:

- Issue creation jobs use an idempotency key such as `create_issue:<repo>:<work_item_id>`.
- PR creation jobs use `open_pr:<repo>:<branch_name>`.
- Before creating, always search `github_links` and GitHub itself for existing issue/PR references.
- Merge jobs use an idempotency key such as `merge_pr:<repo>:<pr_number>:<head_sha>` so a repeated button tap cannot merge an unexpected updated head.

## Event Integration

The existing event model should be reused:

- `bridge_runs` stores run lifecycle.
- `bridge_events` stores coarse lifecycle events and final payloads.
- Background jobs should attach `job_id` and `work_item_id` in event payloads.
- Avoid storing full streaming deltas permanently.

Potential future event types:

- `job.started`
- `job.completed`
- `job.failed`
- `approval.requested`
- `approval.resolved`
- `github.issue.created`
- `github.pr.created`

Do not add these until there is a concrete renderer or audit requirement.

## Prompt Contracts

Each worker task should have a bounded prompt contract.

### Defect scan prompt contract

Required output:

```json
{
  "findings": [
    {
      "title": "string",
      "severity": "low|medium|high|critical",
      "confidence": "low|medium|high",
      "evidence": ["string"],
      "suspected_files": ["string"],
      "recommended_red_test": "string",
      "non_goals": ["string"]
    }
  ]
}
```

### Implementation plan prompt contract

Required output:

```json
{
  "summary": "string",
  "assumptions": ["string"],
  "acceptance_criteria": ["string"],
  "phases": [
    {
      "name": "string",
      "red_test": "string",
      "green_change": "string",
      "verification": "string"
    }
  ],
  "risks": ["string"]
}
```

### TDD fix prompt contract

Required instructions:

- inspect current dirty files
- do not revert unrelated work
- write tests first
- run tests and confirm failure
- commit tests only
- implement
- run tests and confirm pass
- commit implementation only
- produce verification summary

## Security And Safety Model

The autonomous lane increases risk, so the default posture should be conservative.

Required controls:

- allowlist repositories
- allowlist commands or execution profiles per task type
- per-job timeout
- per-job max attempts
- per-job workspace root
- policy required for GitHub issue/branch/push/PR writes
- approval required for service restarts
- approval required for force-pushes and destructive Git operations
- merge permission only through explicit Telegram merge approval
- no direct production deploys
- log redaction for prompts, tokens, and environment values

Secrets:

- never store secrets in `input_json`, `result_json`, bridge events, or Telegram messages
- use existing env files and service-level configuration
- redact command previews that include user prompts or environment values

## Implementation Phases

Every behavior-changing phase must follow red-green-refactor with separate test and implementation commits.

## Document Navigation

This document contains two complementary views of the implementation:

- **Detailed Agent Handoff Plan (Slices 1–17)** — prescriptive, one behavior per slice, with exact files, red tests, green implementation, and commit sequences. Use this as the primary implementation guide.
- **Condensed Handoff Checklist (Phases 0–8)** — summary of the same work grouped at a higher level, suitable for progress tracking and checkpoint reviews. Phases map to slices roughly as: Phase 1 ≈ Slices 1–2, Phase 2 ≈ Slice 2, Phase 3 ≈ Slices 3–5, Phase 4 ≈ Slices 6–8, Phase 5 ≈ Slices 9–10, Phase 6 ≈ Slice 13, Phase 7 ≈ Slice 14, Phase 8 ≈ Slices 15–16.

An implementing agent should follow the **Slices**. The **Phases** are for the human reviewer.

## Detailed Agent Handoff Plan

This is the implementation plan to hand to another coding agent. It assumes the repository remains TypeScript, `better-sqlite3`, Vitest, and synchronous SQLite. It also assumes the existing interactive Telegram bridge remains operational throughout the migration.

### Global TDD Rules For The Implementing Agent

Every slice below must use this exact loop:

1. Write or update the focused test.
2. Run the focused test or `npm test` and confirm the new test fails for the expected reason.
3. Commit tests only:

```text
test: failing coverage for <slice>
```

4. Implement the smallest production change.
5. Run the focused test, then `npm test`, then `npm run typecheck`.
6. Commit production code only:

```text
feat: <slice>
```

or:

```text
fix: <slice>
```

7. Refactor only while tests stay green.

Never commit tests and production code together. If a red test does not fail, stop and rewrite the test.

### Global Acceptance Criteria

The first production-ready milestone is complete only when:

- existing Telegram prompt execution still works
- `/models`, `/skills`, `/memory`, `/reset`, `/usage`, `/stop` behavior is unchanged
- `/jobs` and `/issues` are available
- work item and job state survives process restarts
- callbacks are shorter than 64 bytes
- unauthorized users cannot approve merges or policy exceptions
- read-only `/review` creates local proposed items only
- no GitHub issue, branch, push, or PR occurs outside standing policy
- no merge, service restart, force-push, production deploy, or destructive Git action occurs without approval
- stale PRs are surfaced in a digest and have refresh/hold/close/merge actions
- failed jobs write errors to SQLite and notify Telegram
- `npm test` passes
- `npm run typecheck` passes

### Slice 1: Canonical Work Schema

Purpose: add durable local state without changing Telegram behavior.

Files to touch:

- `src/db.ts`
- `test/db.test.ts`

Production objects:

- `work_items`
- `work_jobs`
- `approvals`
- `github_links`

Required DB methods:

```ts
createWorkItem(input): WorkItem
getWorkItem(id): WorkItem | null
listWorkItems(filter): WorkItem[]
updateWorkItemStatus(id, status): void
createWorkJob(input): WorkJob
getWorkJob(id): WorkJob | null
listWorkJobs(filter): WorkJob[]
createApproval(input): Approval
resolveApproval(id, decision): Approval
linkGithubIssue(input): GithubLink
linkGithubPr(input): GithubLink
```

Red tests:

- opening a new DB creates all four tables
- `PRAGMA foreign_keys` is enabled
- creating a work item returns an id and default `proposed` status
- creating a job with no `work_item_id` is valid for repository scans
- creating two jobs with the same idempotency key fails or returns the existing job by design
- approving/rejecting an approval updates decision fields exactly once
- `github_links` enforces uniqueness for `(repository, issue_number)` and `(repository, pr_number)`

Expected red failure:

- tables or methods do not exist.

Green implementation:

- add migrations in `openDb`
- add typed methods to `BridgeDb`
- keep existing session/lock/run/event methods untouched

Verification:

```bash
npm test -- test/db.test.ts
npm test
npm run typecheck
```

Commit sequence:

```text
test: failing work queue schema coverage
feat: add work queue schema
```

### Slice 2: Job Lease And Recovery Primitives

Purpose: make background execution recoverable before adding any worker process.

Files to touch:

- `src/db.ts`
- `test/db.test.ts`

Required DB methods:

```ts
claimNextWorkJob(workerId, now, leaseSeconds): WorkJob | null
markWorkJobRunning(jobId, workerId): void
heartbeatWorkJob(jobId, workerId, now): void
completeWorkJob(jobId, result): void
failWorkJob(jobId, error): void
recoverExpiredWorkJobs(now): number
cancelWorkJob(jobId, reason): void
```

Red tests:

- one worker can claim the oldest pending job
- a second worker cannot claim an actively leased job
- expired leased jobs become claimable
- heartbeat updates `heartbeat_at`
- completing a job clears lease fields and stores result
- failing a job increments attempt count and stores error
- expired jobs with attempts remaining return to `pending`
- expired jobs with attempts exhausted become `failed`

Expected red failure:

- no lease methods exist.

Green implementation:

- use atomic SQLite updates with `WHERE status = 'pending'`
- store ISO timestamps
- preserve idempotency keys

Verification:

```bash
npm test -- test/db.test.ts
npm test
npm run typecheck
```

Commit sequence:

```text
test: failing job lease lifecycle coverage
feat: add job lease lifecycle
```

### Slice 3: Callback Payload Parser

Purpose: parse compact Telegram callback verbs safely before wiring them to mutations.

Files to touch:

- `src/commands.ts` or new `src/workCallbacks.ts`
- `src/types.ts` if adding callback action types
- `test/bridge.test.ts` or new `test/workCallbacks.test.ts`

Callback grammar:

```text
wi:<id>:view
wi:<id>:appv
wi:<id>:clse
job:<id>:cncl
ap:<id>:yes
ap:<id>:no
```

Required functions:

```ts
parseWorkCallback(data: string): WorkCallbackAction | null
buildWorkCallback(action): string
```

Red tests:

- parses each valid callback
- rejects unknown prefixes
- rejects unknown actions
- rejects missing ids
- rejects non-numeric ids
- rejects payloads over 64 bytes
- builder always returns payloads under 64 bytes

Expected red failure:

- parser/builder does not exist.

Green implementation:

- keep parser pure and independent of Telegram client
- never embed issue body, file path, prompt, command, or secret values

Verification:

```bash
npm test -- test/workCallbacks.test.ts
npm test
npm run typecheck
```

Commit sequence:

```text
test: failing compact callback parser coverage
feat: add compact work callback parser
```

### Slice 4: Work Item Renderers And `/issues`

Purpose: expose proposed work safely in Telegram without starting any jobs.

Files to touch:

- `src/commands.ts`
- `src/render.ts` if helper changes are needed
- `src/engine.ts` if command routing needs callback/detail handling
- `test/bridge.test.ts`
- `test/render.test.ts` if truncation helpers are added

Required behavior:

- `/issues` lists proposed and waiting-approval work items
- `/issue <id>` shows one work item
- list rows include compact inline buttons
- long titles/bodies are truncated or split safely
- unauthorized users cannot trigger mutation callbacks

Red tests:

- `isBridgeCommand("/issues")` is true
- `handleCommand(..., "/issues")` returns a keyboard/message response
- empty issue list renders a useful empty state
- long issue body does not exceed Telegram safe limits
- `/issue 123` renders detail when the work item exists
- `/issue missing` renders not found

Expected red failure:

- commands are not recognized.

Green implementation:

- extend command normalization carefully so existing commands remain unchanged
- add render helper for work item summaries
- use callback builder from Slice 3

Verification:

```bash
npm test -- test/bridge.test.ts
npm test -- test/render.test.ts
npm test
npm run typecheck
```

Commit sequence:

```text
test: failing issues command coverage
feat: add issues command rendering
```

### Slice 5: Approval Callback Handling

Purpose: make Telegram buttons mutate local state safely and idempotently.

Files to touch:

- `src/engine.ts`
- `src/db.ts`
- `src/commands.ts` or `src/workCallbacks.ts`
- `test/engine.test.ts`
- `test/db.test.ts`

Required behavior:

- `wi:<id>:view` shows detail
- `wi:<id>:appv` creates or resolves an approval according to current state
- `wi:<id>:clse` marks a local proposed item rejected/closed
- `job:<id>:cncl` cancels pending jobs
- `ap:<id>:yes` resolves approval as approved
- `ap:<id>:no` resolves approval as rejected
- repeated taps do not duplicate jobs or approvals
- unauthorized users get a harmless rejection message

Red tests:

- authorized approval changes state once
- repeated approval leaves one job
- unauthorized approval does not change DB
- close action does not close a GitHub issue unless an explicit approval payload says so
- callback answer is sent so Telegram does not leave the button spinning

Expected red failure:

- callback actions are not routed.

Green implementation:

- add a callback dispatch branch in the existing callback handling path
- use DB transactions for state changes
- do not call GitHub yet

Verification:

```bash
npm test -- test/engine.test.ts
npm test -- test/db.test.ts
npm test
npm run typecheck
```

Commit sequence:

```text
test: failing work approval callback coverage
feat: add local work approval callbacks
```

### Slice 6: Read-Only Evidence Collector

Purpose: collect churn/typecheck/lint evidence deterministically.

Files to add:

- `src/work/evidence.ts`
- `test/workEvidence.test.ts`

Required behavior:

- run Git churn over last 90 days
- exclude generated/vendor/build paths
- cap result count
- capture typecheck output without throwing
- capture lint output without throwing
- represent missing lint script as skipped, not failed

Suggested types:

```ts
interface ChurnEntry {
  path: string;
  count: number;
}

interface StaticCheckResult {
  command: string;
  status: "passed" | "failed" | "skipped";
  outputPreview: string;
}

interface EvidenceBundle {
  churn: ChurnEntry[];
  staticChecks: StaticCheckResult[];
}
```

Red tests:

- parses churn output into sorted entries
- filters ignored paths
- truncates output previews
- typecheck command failure is captured as `failed`
- missing lint script is captured as `skipped`

Expected red failure:

- module does not exist.

Green implementation:

- keep parsing pure and separately tested
- use child process execution only in a thin wrapper
- do not write temp files unless needed; prefer job `result_json`

Verification:

```bash
npm test -- test/workEvidence.test.ts
npm test
npm run typecheck
```

Commit sequence:

```text
test: failing evidence collector coverage
feat: add read-only work evidence collector
```

### Slice 7: Defect Scan Prompt And JSON Parser

Purpose: convert evidence into proposed local work items through strict JSON.

Files to add:

- `src/work/defectScan.ts`
- `test/defectScan.test.ts`

Required behavior:

- build a prompt that includes evidence and asks for strict JSON
- parse valid scan JSON
- reject invalid JSON
- reject findings missing title, severity, diagnostics, suspected files, or recommended red test
- normalize labels and always include `agent-proposed`

Red tests:

- prompt includes churn evidence
- prompt includes typecheck/lint evidence
- valid JSON returns normalized findings
- invalid JSON throws safe parser error
- missing fields are rejected

Expected red failure:

- module does not exist.

Green implementation:

- pure prompt builder
- pure parser/validator
- no CLI execution in this module

Verification:

```bash
npm test -- test/defectScan.test.ts
npm test
npm run typecheck
```

Commit sequence:

```text
test: failing defect scan parser coverage
feat: add defect scan prompt and parser
```

### Slice 8: `/review` Creates A Local Defect Scan Job

Purpose: let Telegram schedule read-only analysis.

Files to touch:

- `src/commands.ts`
- `src/engine.ts`
- `src/db.ts`
- `test/bridge.test.ts`
- `test/engine.test.ts`

Required behavior:

- `/review` creates a `defect_scan` job
- command response tells the user the job id
- no GitHub issue is created
- no worker execution starts inside Telegram polling

Red tests:

- `/review` is recognized
- handling `/review` inserts one pending `defect_scan` job
- repeated `/review` can either create a new job or return existing pending job according to idempotency rule
- response contains job id

Expected red failure:

- `/review` is ignored.

Green implementation:

- extend command result union if needed
- write job rows through DB method
- keep execution separate from command handling

Verification:

```bash
npm test -- test/bridge.test.ts
npm test -- test/engine.test.ts
npm test
npm run typecheck
```

Commit sequence:

```text
test: failing review command coverage
feat: queue read-only review jobs
```

### Slice 9: Feature Planning State Machine

Purpose: collect feature scope over Telegram before planning.

Files to touch/add:

- `src/db.ts`
- `src/commands.ts`
- `src/work/featurePlanning.ts`
- `test/db.test.ts`
- `test/featurePlanning.test.ts`
- `test/bridge.test.ts`

Required behavior:

- `/feature <brief>` starts a planning state
- follow-up messages can update scope
- state survives restart because it is stored in SQLite
- `/plan` can finalize the plan request when required fields are present
- stale planning state can be cancelled or expired

Suggested additional table:

```sql
CREATE TABLE feature_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  brief TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Red tests:

- creating a feature plan stores chat/user/brief
- updating scope merges new fields
- loading active plan by chat/user works
- `/feature <brief>` responds with next requested information
- `/plan` rejects incomplete scope with a clear message

Expected red failure:

- planning state does not exist.

Green implementation:

- add persistence methods
- add prompt/response state helpers
- avoid starting CLI execution in this slice

Verification:

```bash
npm test -- test/featurePlanning.test.ts
npm test -- test/db.test.ts
npm test
npm run typecheck
```

Commit sequence:

```text
test: failing feature planning state coverage
feat: add feature planning state
```

### Slice 10: Feature Plan Prompt And Parser

Purpose: force implementation-ready plans with target footprint and red test details.

Files to add:

- `src/work/featurePlanSpec.ts`
- `test/featurePlanSpec.test.ts`

Required Markdown sections:

- `Target Footprint`
- `Red Test Specification`
- `State And Schema Alterations`
- `Implementation Phases`
- `Verification`
- `Rollback`

Red test specification must include:

- file path
- framework/command
- assertion
- expected red failure reason

Red tests:

- valid plan parses successfully
- missing target footprint is rejected
- missing red test path is rejected
- missing command is rejected
- missing expected failure reason is rejected
- explicit "no schema changes" is accepted

Expected red failure:

- parser does not exist.

Green implementation:

- build prompt template
- parse Markdown sections
- validate required content

Verification:

```bash
npm test -- test/featurePlanSpec.test.ts
npm test
npm run typecheck
```

Commit sequence:

```text
test: failing feature plan specification coverage
feat: add feature plan specification parser
```

### Slice 11: Worker Service Skeleton

Purpose: add a worker that can process safe no-op jobs before real scan jobs.

Files to add/touch:

- `src/worker.ts`
- `src/work/worker.ts`
- `test/worker.test.ts`
- `test/systemd.test.ts` later only if service files are added

Required behavior:

- worker claims one job
- worker runs the matching executor
- unknown task types fail safely
- exceptions are stored in `work_jobs.error`
- Telegram notification function is injected/mocked
- worker exits cleanly in single-iteration test mode

Red tests:

- single iteration claims and completes a no-op job
- unknown task type marks job failed
- thrown executor error marks job failed
- notification is called on failure

Expected red failure:

- worker module does not exist.

Green implementation:

- write pure worker loop function:

```ts
runWorkerOnce({ db, workerId, executors, notify }): Promise<void>
```

- do not add `setInterval` until single-iteration behavior is tested
- keep Telegram bot process separate

Verification:

```bash
npm test -- test/worker.test.ts
npm test
npm run typecheck
```

Commit sequence:

```text
test: failing worker skeleton coverage
feat: add worker skeleton
```

### Slice 12: Defect Scan Executor

Purpose: execute read-only `/review` jobs.

Files to touch/add:

- `src/work/defectScanExecutor.ts`
- `src/work/evidence.ts`
- `src/work/defectScan.ts`
- `test/defectScanExecutor.test.ts`

Required behavior:

- collect evidence
- invoke configured CLI agent with strict prompt
- parse JSON response
- create local proposed work items
- complete job with summary result
- fail job safely on parser errors

Red tests:

- executor creates work items from valid CLI result
- executor fails job on invalid JSON
- executor does not call GitHub
- executor stores evidence summary in result

Expected red failure:

- executor does not exist.

Green implementation:

- inject CLI runner for tests
- inject evidence collector for tests
- use DB transaction when creating multiple work items

Verification:

```bash
npm test -- test/defectScanExecutor.test.ts
npm test
npm run typecheck
```

Commit sequence:

```text
test: failing defect scan executor coverage
feat: add read-only defect scan executor
```

### Slice 13: Policy-Based GitHub Issue Creation Adapter

Purpose: create GitHub issues automatically when repository policy permits it.

Files to add/touch:

- `src/work/githubIssues.ts`
- `test/githubIssues.test.ts`
- `src/work/worker.ts`

Required behavior:

- in-policy local work item can create one GitHub issue
- issue creation is idempotent
- `github_links` records repository and issue number
- out-of-policy issue creation creates a policy-exception approval instead of calling GitHub
- errors are stored in job error

Red tests:

- adapter builds expected issue payload
- existing `github_links` prevents duplicate creation
- mocked GitHub create failure marks job failed
- policy allows in-policy issue creation without per-issue approval
- policy blocks out-of-policy issue creation and requests exception approval

Expected red failure:

- adapter does not exist.

Green implementation:

- inject GitHub command/API adapter
- avoid direct `gh` calls in pure logic
- use idempotency key before creation

Verification:

```bash
npm test -- test/githubIssues.test.ts
npm test
npm run typecheck
```

Commit sequence:

```text
test: failing policy based github issue adapter coverage
feat: add policy based github issue creation
```

### Slice 14: Approved TDD Implementation Executor

Purpose: queue implementation jobs and let normal branch/commit work proceed inside policy.

Files to add/touch:

- `src/work/tddExecutor.ts`
- `test/tddExecutor.test.ts`
- `src/cli.ts` only if a reusable CLI wrapper is needed

Required behavior:

- refuses to start on unrelated dirty worktree
- creates an isolated branch name such as `agent/work-<id>`
- prompt enforces red test commit and green implementation commit
- captures verification summary
- pushes branch and opens or updates a draft PR when policy permits it
- stops and requests a policy-exception approval only when the job exceeds policy

Red tests:

- dirty worktree guard blocks start
- branch name is deterministic and safe
- prompt contains explicit red-green commit split
- successful local execution creates/updates a draft PR when policy permits it
- out-of-policy branch/push/PR request creates exception approval and does not push

Expected red failure:

- executor does not exist.

Green implementation:

- inject Git adapter and CLI runner
- use existing CLI timeout/config where possible
- make source-control commands explicit and mocked in tests

Verification:

```bash
npm test -- test/tddExecutor.test.ts
npm test
npm run typecheck
```

Commit sequence:

```text
test: failing policy based tdd executor coverage
feat: add policy based tdd implementation executor
```

### Slice 15: PR Lifecycle Manager

Purpose: prevent stale PR accumulation by actively refreshing, holding, closing, or preparing PRs for merge.

Files to add/touch:

- `src/work/githubPullRequests.ts`
- `src/work/prLifecycle.ts`
- `test/githubPullRequests.test.ts`
- `test/prLifecycle.test.ts`
- `src/work/worker.ts`

Required behavior:

- branch push is idempotent
- PR creation is idempotent
- `github_links` records PR number and branch
- existing agent PRs are refreshed before new PRs are opened
- open agent PR cap is enforced
- CI failure can trigger one auto-fix job within retry policy
- stale PRs are included in a digest
- ready PRs request merge approval
- held PRs do not keep retrying until released

Red tests:

- open PR cap blocks new PR creation and reports a queue hold
- existing PR link prevents duplicate PR
- mocked push failure stores error
- mocked PR creation success stores link
- stale PR is marked `agent-stale`
- ready PR creates a merge approval request
- held PR is skipped by refresh jobs

Expected red failure:

- PR lifecycle manager does not exist.

Green implementation:

- inject GitHub adapter
- use `github_links` for idempotency
- add lifecycle state transitions
- do not merge in this slice

Verification:

```bash
npm test -- test/prLifecycle.test.ts
npm test -- test/githubPullRequests.test.ts
npm test
npm run typecheck
```

Commit sequence:

```text
test: failing pr lifecycle coverage
feat: add pr lifecycle management
```

### Slice 16: Telegram Merge Approval Executor

Purpose: make PR merge the final routine approval gate.

Files to add/touch:

- `src/work/githubMerge.ts`
- `test/githubMerge.test.ts`
- `src/work/prLifecycle.ts`
- `src/engine.ts`

Required behavior:

- ready PRs produce a Telegram merge approval request
- merge approval payload includes repository, PR number, and expected head SHA
- repeated merge button taps are idempotent
- changed head SHA blocks merge and asks for refresh/re-review
- successful merge updates `github_links`, `work_items`, and `work_jobs`
- failed merge writes error and reports to Telegram

Red tests:

- merge cannot run without approved merge approval
- expected head SHA mismatch blocks merge
- repeated merge approval does not run merge twice
- successful merge marks work item resolved
- merge failure leaves PR in ready/needs-human state

Expected red failure:

- merge executor does not exist.

Green implementation:

- inject GitHub merge adapter
- use idempotency key `merge_pr:<repo>:<pr_number>:<head_sha>`
- never merge if checks are unknown or failing

Verification:

```bash
npm test -- test/githubMerge.test.ts
npm test -- test/prLifecycle.test.ts
npm test
npm run typecheck
```

Commit sequence:

```text
test: failing merge approval coverage
feat: add telegram gated pr merge
```

### Slice 17: Operational Health And Docs

Purpose: make autonomous jobs observable.

Files to touch:

- `src/health/plugins/self.ts` or a new worker health plugin
- `test/health.test.ts`
- `docs/PRD.md`
- this research doc if needed
- systemd docs only after service behavior is stable

Required health checks:

- pending job count
- running leased job count
- expired lease count
- failed job count
- last successful worker heartbeat

Red tests:

- health report includes worker queue metrics
- expired leases produce amber/red according to threshold
- no jobs produces green

Expected red failure:

- health plugin has no worker metrics.

Green implementation:

- add health query helpers
- add report checks
- document service operation

Verification:

```bash
npm test -- test/health.test.ts
npm test
npm run typecheck
```

Commit sequence:

```text
test: failing worker health coverage
feat: add worker health checks
docs: document autonomous worker operation
```

### Final Release Verification

Before pushing or restarting services:

```bash
npm test
npm run typecheck
git status --short
```

Manual smoke checks:

- `/issues` empty state
- `/review` queues a job
- worker processes one read-only scan job
- failed test worker job reports to Telegram
- approval callback rejects unauthorized user
- approval callback is idempotent
- existing normal prompt execution still works
- `/stop` still aborts an active CLI process

Rollback:

- stop worker service first
- leave Telegram bridge running
- disable new commands if needed by feature flag
- SQLite additions are additive and should not require destructive rollback

Feature flags:

- `WORK_QUEUE_ENABLED`
- `WORKER_ENABLED`
- `DEFECT_SCAN_ENABLED`
- `FEATURE_PLANNING_ENABLED`
- `GITHUB_ISSUE_WRITE_ENABLED`
- `GITHUB_PR_WRITE_ENABLED`
- `GITHUB_MERGE_APPROVAL_ENABLED`

**Where flags live:** `.env.shared` for flags that apply to both the Telegram bot process and the worker process; `.env.worker` for worker-only flags. This is consistent with the existing bridge `.env.*` pattern. Never put flags in SQLite — they need to be readable before the DB is opened.

Default all flags to off except local read-only rendering/tests until the corresponding phase is verified. Enabling PR writes should not enable merge; merge must remain gated by Telegram approval.

## Condensed Handoff Checklist

This checklist maps the original blueprint phases to the safer design recommended in this document. It is suitable for a later implementation agent to pick up, but each checkbox still needs a red test commit before production code is written.

### Handoff Phase 1: Database And Telegram Wiring

Original request:

- implement `agent_issues` and `job_queue`
- intercept colon-delimited callbacks such as `iss:num:action`
- build `/issues` with Telegram-safe truncation

Recommended implementation:

- implement `work_items` and `work_jobs` as the canonical tables
- add compatibility views or naming aliases later only if the UI needs `agent_issues` / `job_queue` terminology
- add `approvals` and `github_links` in the same schema phase because callback approval state and GitHub idempotency are first-class requirements, not later extras
- register compact callback handlers:

```text
wi:<id>:view
wi:<id>:appv
wi:<id>:clse
job:<id>:cncl
ap:<id>:yes
ap:<id>:no
```

- validate callback payload length is below Telegram's 64-byte limit
- load full action payloads from SQLite, not from callback strings
- render `/issues` from local proposed/approval-waiting work items
- truncate long issue summaries through the existing Telegram rendering/splitting utilities

Red tests:

- schema migration creates canonical work tables
- `/issues` lists proposed work items
- long summaries are truncated or split without invalid Telegram payloads
- callback payloads under 64 bytes are parsed into stable actions
- unauthorized callback users cannot mutate state
- repeated approval callbacks are idempotent

Green implementation:

- extend `src/db.ts`
- extend command parsing and callback handling
- add Telegram issue list/detail renderers

### Handoff Phase 2: Skill 1 Integration - Defect Isolation

Original request:

- create a shell/TypeScript harness for churn and static analysis
- author JSON prompt schema for defect identification
- connect output to `/review` and local records first

Recommended implementation:

- create a TypeScript evidence collector rather than a shell-only harness so filtering and tests are deterministic
- use shell commands only at the boundary:

```bash
git log --since="90 days ago" --format=format: --name-only
npm run typecheck
npm run lint
```

- write normalized evidence to a temporary artifact or job result payload
- force the scan agent to return strict JSON
- reject non-JSON or schema-invalid output
- create local `work_items`
- create GitHub issues automatically only when repository policy permits it; otherwise request a policy exception

Required JSON shape:

```json
{
  "findings": [
    {
      "title": "string",
      "severity": "low|medium|high|critical",
      "confidence": "low|medium|high",
      "diagnostics": ["string"],
      "suspected_files": ["string"],
      "churn_evidence": ["string"],
      "static_analysis_evidence": ["string"],
      "recommended_red_test": "string",
      "github_labels": ["agent-proposed"]
    }
  ]
}
```

Red tests:

- churn collector filters generated/vendor files
- static analysis failures are captured without crashing the worker
- valid JSON creates local proposed work items
- invalid JSON fails the scan job with a useful error
- `/review` does not create GitHub issues unless repository policy explicitly permits it

Green implementation:

- add evidence collector
- add defect prompt builder
- add schema validator
- add `/review` job creation

### Handoff Phase 3: Skill 2 Integration - Feature Planning

Original request:

- build multi-turn Telegram state for feature scope
- force Target Footprint, Red Test Specification, and Schema Changes
- policy creates GitHub issue and queues work; exception approval is used only when outside policy

Recommended implementation:

- start with a bounded state machine in SQLite keyed by chat/user
- keep each planning turn resumable across bot restarts
- support `/feature <brief>` as the entry command
- output a Markdown plan plus machine-readable metadata for queueing
- policy creates the GitHub issue only once
- policy queues implementation only after issue creation has a link in `github_links`

Required Markdown sections:

```text
## Target Footprint
## Red Test Specification
## State And Schema Alterations
## Implementation Phases
## Verification
## Rollback
```

Red tests:

- `/feature <brief>` starts planning state
- follow-up answers update state
- restart-safe state can be resumed
- plan output missing target footprint is rejected
- plan output missing red test path/command/assertion is rejected
- policy-based issue/job creation is idempotent and creates one issue/job pair

Green implementation:

- add planning state persistence
- add prompt template and parser
- add policy-to-issue workflow
- add policy-to-job workflow

### Handoff Phase 4: Async Worker Activation

Original request:

- build interval or cron worker polling `job_queue`
- lock rows before shell execution
- trap failures into `error_log` and notify Telegram

Recommended implementation:

- prefer a separate systemd service running a worker entry point over an in-process `setInterval` inside the Telegram bot
- use SQLite leases, not only `status = processing`
- store `attempt_count`, `lease_owner`, `lease_expires_at`, and `heartbeat_at`
- route shell execution through existing CLI/run helpers where possible
- trap failures into `work_jobs.error`
- send Telegram notification on failure, merge-ready state, stale PR digest, or policy-exception state
- never let worker errors crash the Telegram polling process

Required worker lifecycle:

```text
pending -> leased -> running -> completed
pending -> leased -> running -> waiting_merge
pending -> leased -> running -> waiting_policy_exception
pending -> leased -> running -> failed
running + expired lease -> pending if attempts remain
running + expired lease -> failed if attempts exhausted
```

Red tests:

- pending job can be leased by one worker
- concurrent workers cannot claim the same job
- expired lease can be reclaimed
- shell/CLI failure is written to job error
- failure sends Telegram notification
- worker exception does not crash the bot process

Green implementation:

- add worker entry point
- add lease/recovery DB methods
- add failure notification path
- add systemd unit docs after the worker is stable

Do not run `git checkout -b`, `npm test`, push, PR creation, or merge from a generic worker loop. Implementation and PR lifecycle jobs need task-specific executors, repository policy checks, and a final Telegram merge gate because they carry source-control risk.

### Phase 0: New Bot Infrastructure (No Automation Yet) ✅

**Status: Complete.** Both bots deployed, enabled, and running. 506/506 tests passing.

**What was shipped:**
- `src/interactiveBot.ts` — CLI preference DB helpers, `/cli` inline keyboard (`buildCliKeyboard`), `handleCliSwitchCallback`, `buildInteractiveCommands`, `resolveUpdateChatKey`, `isAuthorizedInteractiveUpdate`
- `src/workerBot.ts` — `/jobs`, `/issues`, `/review` stubs; `/models` shows fallback chain keyboard; `buildWorkerCommands`
- `src/workerFallback.ts` — `WorkerFallbackChain`: per-chat CLI chain state + last-3-turns context history; `CONTEXT_TURNS=3`
- `src/workerDispatch.ts` — `dispatchWithFallback`: routes update to active CLI engine; on capacity exhaustion advances chain, injects context preamble, retries with next CLI
- `src/index-interactive.ts` — polls one bot token, routes to active CLI engine; `setMyCommands` at startup and after every `/cli` tap; `cli:*` callbacks edit message in-place
- `src/index-worker.ts` — polls worker bot token; plain messages routed through `dispatchWithFallback`; worker commands handled by `handleWorkerCommand`; 3 `BridgeEngine` instances (one per CLI); `onCapacityExhausted` hook marks chat for fallback; `onBeforeExecute` injects context preamble on retry
- `src/engine.ts` — added `onCapacityExhausted` hook to `BridgeEngineHooks`; fires instead of sending error message when hook is registered and error is capacity-type
- `src/bridge.ts` — `parseModelPreference` extracted here (was duplicated in both entry points)
- `systemd/agent-bridge-interactive.service` + `systemd/agent-bridge-worker-bot.service` — both `KillMode=control-group`, `Restart=always`
- `/etc/default/agent-bridge-interactive` + `/etc/default/agent-bridge-worker-bot` — tokens, env config, model preferences for all 3 CLIs
- `/skills` and `/memory` removed from all bot command palettes (handlers remain); `/switch` removed, `/cli` is the single switching surface

**Resolved decisions:**

- Two new Telegram bots are being added alongside the existing three CLI bots (Codex, Claude, Antigravity). The existing bots remain operational and unchanged.
- GitHub issue creation is deferred to Phase 6. Phases 1–5 create local work items only.
- Default repository target: `agent-bridge` (the bridge itself is the first subject).
- Agy auth is resolved — Agy is eligible for the worker fallback chain.

**New bot 1: Autonomous Worker Bot**

A new Telegram bot dedicated to background autonomous work. It has no direct CLI conversation. It receives job commands, queues work items, and reports outcomes.

CLI fallback chain for job execution:

```text
codex → claude → antigravity
```

On each failure (rate limit, auth error, timeout): try next CLI in chain. On exhaustion: job stays `pending`, Telegram notification sent, user decides whether to retry or cancel.

Fallback chain is configurable via `.env.worker`:

```bash
WORKER_BOT_TOKEN=<new-bot-token>
WORKER_CLI_CHAIN=codex,claude,antigravity
WORKER_DEFAULT_REPO=agent-bridge
WORKER_ENABLED=false           # off until Phase 4
WORK_QUEUE_ENABLED=true        # schema and commands active from Phase 1
```

Phase 0 scope for this bot: wire up the bot, register commands (`/jobs`, `/issues`, `/review`), confirm Telegram connectivity and command routing. No job execution yet — `WORKER_ENABLED=false`.

**New bot 2: Unified Interactive Bot**

A new Telegram bot that presents a single conversation surface but routes under the hood to a preferred CLI. Useful for evaluating the UX before committing to replacing the individual bots.

CLI preference is per-user, stored in SQLite, and changeable mid-session:

```text
/switch codex     ← route all subsequent prompts to Codex
/switch claude    ← route to Claude
/switch agy       ← route to Antigravity
/cli              ← show current active CLI and available options
```

Default preference order: `codex` first. On explicit `/switch`, the chosen CLI becomes the active one for that user's session (persisted across restarts).

No automatic fallback in the interactive bot — a rate-limited CLI surfaces an error and prompts the user to `/switch` manually. Silent fallback in an interactive session loses conversation context, which is worse than a transparent error.

Config in `.env.interactive`:

```bash
INTERACTIVE_BOT_TOKEN=<new-bot-token>
INTERACTIVE_DEFAULT_CLI=codex
```

Phase 0 scope for this bot: wire up the bot, implement `/switch` and `/cli` commands, confirm CLI routing works for plain prompts, evaluate UX alongside the existing separate bots.

**Phase 0 deliverables:**

1. Register two new bots via BotFather, obtain tokens.
2. Add `.env.worker` and `.env.interactive` with tokens and chain config.
3. Add `src/workerBot.ts` and `src/interactiveBot.ts` entry points.
4. Add `agent-bridge-worker-bot.service` and `agent-bridge-interactive-bot.service` systemd units with `KillMode=control-group`.
5. Worker bot: receives `/jobs`, `/issues`, `/review` — acknowledges with job IDs, no execution yet.
6. Interactive bot: receives any prompt, routes to active CLI, supports `/switch` and `/cli`.
7. Add `user_cli_preference` table or column to SQLite for interactive bot state.
8. Both services running and stable alongside the three existing bots.
9. Evaluate interactive bot UX for one week before enabling `WORKER_ENABLED=true`.

**Open questions resolved by Phase 0:**

- Which bot handles worker jobs? → Dedicated worker bot with fallback chain. Not the interactive bot.
- Single bot or multiple? → Additive for now: two new bots plus existing three.
- Default CLI for worker? → Codex first.
- GitHub issue creation in scope for early phases? → No. Deferred to Phase 6.

**Still open:**

- Default open PR cap per repository (suggested: 3).
- Daily new PR cap per repository (suggested: 3).
- Stale PR threshold before digest (suggested: 48 hours).

### Phase 1: Durable work schema ✅ Complete

Covers Slices 1–2 from the Detailed Agent Handoff Plan.

Red tests:

- migrations create `work_items`, `work_jobs`, `approvals`, and `github_links`
- foreign keys are enabled
- job idempotency key is unique
- work item can exist without GitHub issue
- job can exist without work item for repository scans

Green implementation:

- extend `src/db.ts` migrations
- add typed DB methods for creating and fetching work items/jobs/approvals

Verification:

```bash
npm test
npm run typecheck
```

### Phase 2: Job lease lifecycle ✅ Complete

Red tests:

- worker can claim one pending job
- second worker cannot claim same job before lease expiry
- expired leased job can be reclaimed
- heartbeat extends observability
- max attempts marks job failed

Green implementation:

- add job lease methods
- add startup recovery for expired jobs

Verification:

```bash
npm test
npm run typecheck
```

### Phase 3: Telegram job commands 🔄 In progress

Red tests:

- `/jobs` lists active and pending jobs
- `/job <id>` renders details
- `/issues` lists proposed and approval-waiting work items
- `/issue <id>` renders the selected work item
- approval callback updates approval state
- compact callback payloads stay below Telegram's 64-byte limit
- repeated callback taps are idempotent
- unauthorized users cannot approve

Green implementation:

- extend command parser
- add Telegram renderers for jobs and approvals
- add callback handlers
- add issue/work item list and detail renderers

Verification:

```bash
npm test
npm run typecheck
```

### Phase 4: Read-only defect scan

Red tests:

- `/review` creates a `defect_scan` job
- churn collection is scoped to the last 90 days
- generated/vendor/build files are excluded from churn results
- typecheck/lint evidence is attached when available
- scan job produces proposed work items from valid JSON output
- invalid scan output fails the job with a safe error
- scan does not create GitHub issues

Green implementation:

- add worker service entry point
- add churn/static-analysis evidence collector
- add read-only scan prompt builder
- parse scan result into proposed work items
- send Telegram summary

Verification:

```bash
npm test
npm run typecheck
```

### Phase 5: Feature planning loop

Red tests:

- `/feature <brief>` creates a feature planning job
- `/plan` creates a planning job
- planning output must include acceptance criteria and TDD phases
- planning output must include target footprint
- planning output must include red test specification with exact path, command, assertion, and expected failure reason
- planning output must include state/schema alterations or explicitly state that none are required
- missing red-green steps causes the plan to be rejected

Green implementation:

- add plan prompt builder
- add plan parser
- add work item update path
- add approval path for creating a GitHub issue from the accepted plan

Verification:

```bash
npm test
npm run typecheck
```

### Phase 6: Policy-based GitHub issue creation

Red tests:

- proposed work item can create a GitHub issue when repository policy permits it
- out-of-policy issue creation requests exception approval
- policy creates one issue only
- retry does not duplicate issue
- blocked issue creation leaves work item local

Green implementation:

- add GitHub issue adapter
- add idempotency checks
- write `github_links`

Verification:

```bash
npm test
npm run typecheck
```

### Phase 7: Policy-based TDD implementation job

Red tests:

- in-policy work item creates `run_tdd_fix` job
- dirty worktree guard blocks unsafe start
- TDD prompt includes separate test and implementation commit requirements
- job result records branch, commits, and verification
- in-policy implementation opens or updates a draft PR
- out-of-policy implementation requests exception approval

Green implementation:

- add implementation worker path
- reuse existing CLI runner where possible
- capture results and events
- open/update draft PR inside policy
- request merge approval only when PR is ready

Verification:

```bash
npm test
npm run typecheck
```

### Phase 8: PR lifecycle and merge gate

Red tests:

- PR creation is idempotent
- PR metadata links back to work item
- open agent PR cap is enforced
- stale PRs are detected and reported
- ready PRs request merge approval
- merge requires expected head SHA
- successful merge closes the work item

Green implementation:

- add GitHub PR adapter
- add branch push/open PR job
- add Telegram result summary
- add stale/refresh/hold states
- add merge approval executor

Verification:

```bash
npm test
npm run typecheck
```

## Operational Readiness Checklist

Before enabling scheduled autonomous scans:

- worker service has its own systemd unit
- worker logs are separate from Telegram bot logs
- job lease recovery tested
- `/jobs` and `/cancel_job` work
- scan jobs are read-only
- GitHub writes are constrained by repository policy
- PR merge requires Telegram approval
- open agent PR cap is configured
- stale PR digest is enabled
- all prompts redact secrets
- max runtime and max attempts configured
- health check includes worker queue depth and stuck jobs
- docs include rollback steps

## Open Questions

1. ~~Should the worker use the Codex bot by default, or inherit from the chat/bot that created the work item?~~ **Resolved: dedicated worker bot with fallback chain `codex → claude → antigravity`. Not inherited from the interactive session.**
2. Should defect scans open local-only work items first, or create GitHub issues automatically when confidence and policy thresholds pass? **Working assumption: local-only until Phase 6. GitHub issue creation requires explicit policy enablement.**
3. ~~Should scheduled scans run all repositories or only an allowlisted default repository?~~ **Resolved: allowlisted only. Default repo: `agent-bridge`. Additional repos require explicit policy configuration.**
4. What are the default open PR cap and daily PR creation cap per repository? **Working assumption: 3 open PRs, 3 new PRs per day. To be confirmed before Phase 8.**
5. How much local artifact retention is acceptable before cleanup is required? **To be decided before Phase 4 worker activation.**
6. Should GitHub label sync be one-way from local state to GitHub, or bidirectional? **To be decided before Phase 6.**
7. ~~Should implementation jobs run in separate worktrees to avoid colliding with interactive bridge work?~~ **Resolved: yes.** Implementation jobs (Slice 14, `run_tdd_fix`) must always operate in an isolated git worktree (`git worktree add`), never in the main checkout. This prevents the dirty-state guard from blocking interactive bridge work and avoids branch conflicts when the user is also working in the repo. The worktree is created at job start and removed after the job completes or fails. The existing `superpowers:using-git-worktrees` skill documents the mechanics.

## Recommendation

Proceed, but in narrow slices.

The best first production slice is:

1. Add durable work/job/approval schema.
2. Add worker lease lifecycle.
3. Add `/jobs` visibility and cancellation.
4. Add read-only defect scan that creates local proposed work items only.

Do not start with autonomous code modification. The bridge should first prove that durable background work, leases, Telegram visibility, and policy records are boringly reliable. Once that is stable, add policy-based GitHub issue creation, policy-based TDD implementation, PR lifecycle management, and Telegram-gated merge.
