# Engineering Worker Architecture

## Status

Canonical architecture documentation.

## Purpose

The Engineering Worker is the software-engineering-only autonomous work engine inside Agent Bridge OSS.

It is not a chatbot and not a general-purpose agent framework. It exists to convert approved software work into tested branches and pull requests while preserving explicit human approval for merges and destructive operations.

## Core Workflow

```text
Work item
→ Planning
→ Architecture review
→ TDD
→ Implementation
→ Testing
→ Review
→ Repair
→ Pull request
→ CI
→ Reviewer comments
→ Merge approval
```

## Responsibilities

The Engineering Worker owns:

- repository resolution

When the frontier advisor is enabled, `orchestrated_task` requests bounded
advisor checkpoints after planning and after successful verification. Plan
advice is folded into the execution contract; PR-readiness advice is attached
to the completed job result. Checkpoints are advisory and fail-open unless the
job explicitly sets `advisor_required=true`. Logical calls are budgeted per
task and each provider attempt is audited. The audit tables do not store
prompts or raw advice; bounded selected checkpoint advice is intentionally
carried in resumable job phase/result state so a worker restart does not
discard it.

### Blocked executor debug escalation

An executor that cannot make safe progress may return the validated
`BLOCKED / NEEDS_ADVISOR` contract. The executor cannot invoke the advisor
directly. Agent Bridge may start one bounded debug investigation using the
already configured trusted `AdvisorService`.

Advisor providers remain `toolMode: none`. The first advisor turn may request
up to six typed read-only evidence operations. Agent Bridge validates and
executes those operations through `AdvisorEvidenceToolBroker`, then supplies
the bounded results for one final advisor response. Initial evidence tools are
limited to:

- worktree-confined file listing, UTF-8 text reads, and literal search;
- fixed-shape Git status, diff, show, and log operations;
- existing acceptance criteria, plan, test-failure, and attempt-summary data.

The evidence broker denies traversal, symlink paths, sensitive files, binary
content, unsupported Git objects, arbitrary commands, and configured
call/byte/time limits. Tool audit records contain metadata and stable evidence
identifiers, not unrestricted file contents or secrets.

Both model turns and any fallback attempts share one logical advisor request
and task budget. A `retry` verdict is checkpointed into existing job phase data
and permits exactly one resumable executor retry. A repeated blocked result, a
`needs_human` verdict, or unavailable advice ends with a bounded human-needed
result. No advisor loop is permitted.

The advisor has no file/Git write, arbitrary shell, network, SQL, service,
deployment, approval, merge, or final-message authority. Deterministic
verification and human gates remain authoritative.

- disposable clones / workspaces
- work item and job state
- software planning
- architecture/refactor review
- TDD implementation
- test and verification commands
- Git operations inside policy
- GitHub issue and PR lifecycle
- CI reaction
- reviewer feedback handling
- repair attempts
- merge approval requests

## Invariants

1. Nothing merges without explicit human approval.
2. Destructive operations require explicit human approval.
3. Implementation work happens in disposable clones/workspaces, not live checkouts.
4. GitHub is a delivery surface, not the internal queue.
5. SQLite remains the local source of work/job/approval truth.
6. Worker findings are proposals until accepted or validated through the workflow.
7. Routine work may proceed inside policy, but policy exceptions must stop and request approval.
8. Advisor evidence tools are Bridge-owned, read-only, bounded, and never grant mutation authority.
9. A blocked worker attempt may receive at most one advisor-guided executor retry.

## Approval Model

Approval is required for:

- merging a PR
- destructive Git operations
- force-pushing
- deleting branches outside approved merge cleanup
- service restarts
- production deploys
- secret/config changes
- permission changes
- exceeding configured caps
- changing standing policy

Routine in-policy steps may proceed without repeated approval:

- create local work item
- create branch
- write failing tests
- commit tests
- implement fix
- run verification
- push agent branch
- open or update draft PR
- refresh a PR non-destructively
- request merge approval

## Product Boundary

The worker may consume Shared Runtime services such as provider selection, memory, notifications, diagnostics, and capability registry metadata.

It must not become the home for general-purpose conversational tools, internet research features, or transport-specific chat behavior.

## Operational Guide

For current commands, configuration, and troubleshooting, use:

- `docs/WORKER-GUIDE.md`
