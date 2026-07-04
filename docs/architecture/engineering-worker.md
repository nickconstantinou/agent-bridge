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
