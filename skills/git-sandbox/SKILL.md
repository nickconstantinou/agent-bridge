---
name: git-sandbox
description: "Use for isolating substantial changes or new features by creating git worktree feature branches, Draft PRs, and sandbox testing before merging."
---

# Git Sandbox and Feature Branch Isolation Workflow

Use this workflow to isolate large or complex changes from the main workspace to keep the working tree clean and enable validation before merging.

## Workflow Steps

1. **Isolate Workspace**: Create a feature branch and isolate the workspace using `git worktree` or framework-specific workspace branching.
   ```bash
   git worktree add ../worktree-name -b feature/name
   cd ../worktree-name
   ```
2. **Commit Incremental Changes**: Follow TDD by splitting test reproduction and implementation commits.
   - Commit 1: `test: write failing test`
   - Commit 2: `feat: implement fix`
3. **Open Draft PR**: Push the branch and open a Draft Pull Request using GitHub CLI (`gh`).
   ```bash
   git push -u origin feature/name
   gh pr create --draft --fill
   ```
4. **Merge and Cleanup**: Once verified, merge the PR (squash-merge preferred), clean up the local worktree, and delete the branch.
   ```bash
   gh pr merge --squash --delete-branch
   git checkout main
   git pull
   # Remove the worktree directory when done
   git worktree remove ../worktree-name
   ```
