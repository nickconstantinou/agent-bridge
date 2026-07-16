# Guarded production rollout

Status: operational contract and installation guide. Installing or merging this helper does not authorize a production rollout.

## Safety model

`rollout-agent-bridge` is a root-owned, narrow orchestration helper. It is separate from `restart-agent-bridge` and accepts only an exact, full Git commit SHA. It never fetches, pulls, checks out, resets, commits, discards queues, or changes its fixed service/database inventory.

The enforced sequence is:

1. Acquire the exclusive OS rollout lock.
2. Verify the fixed config, all seven services, all five databases, clean `main`, and the exact expected commit.
3. Reject unknown schemas, missing databases, non-canonical paths, integrity failures, or nonzero legacy queues.
4. Stop every service and prove each is inactive.
5. Recheck Git and database preconditions.
6. Create byte-exact, hash-recorded SQLite backups after proving no WAL/SHM sidecars remain.
7. Run the repository's additive migrations and validate the current schema.
8. Start every service, verify active state, inspect startup error logs, and revalidate databases.

Every phase writes a timestamped log plus JSON evidence and SHA-256 manifests. A failure before services start restores every database from the verified backup and leaves services stopped. A failure during or after start stops all services, preserves migrated databases and evidence, and requires operator review. The helper deliberately does not attempt an automatic post-start code/database rollback.

## Installation

Review and install the helper and fixed inventory as root:

```bash
sudo install -D -m 0750 -o root -g root scripts/rollout-agent-bridge.sh /usr/local/sbin/rollout-agent-bridge
sudo install -D -m 0600 -o root -g root systemd/agent-bridge-rollout.conf.example /etc/agent-bridge/rollout.conf
sudoedit /etc/agent-bridge/rollout.conf
sudo visudo -f /etc/sudoers.d/agent-bridge-rollout
```

Sudoers content:

```sudoers
content-crawler ALL=(root) NOPASSWD: /usr/local/sbin/rollout-agent-bridge
```

The config must remain `root:root`, must not be group/world writable, and must contain exactly five canonical, non-symlink database paths. Confirm the Node binary and all paths match the host before requesting deployment approval.

## Authorized invocation

Only after separate production approval:

```bash
sudo -n /usr/local/sbin/rollout-agent-bridge --expected-commit <full-40-character-main-sha>
```

Artifacts are written beneath the configured `log_dir`; database snapshots are written beneath `backup_dir`. On any failure, keep services stopped and inspect the newest artifact path recorded in `log_dir/latest` before taking further action.

Legacy queue discard is intentionally unsupported. A nonzero legacy queue count aborts before service stop and requires a separate explicit operational decision and tool.
