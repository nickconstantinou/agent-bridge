# Guarded production rollout

Status: operational contract and installation guide. Installing or merging this helper does not authorize a production rollout.

## Safety model

`rollout-agent-bridge` is a root-owned, narrow orchestration helper. It is separate from `restart-agent-bridge` and accepts only an exact, full Git commit SHA. It never fetches, pulls, checks out, resets, commits, discards queues, or changes its fixed service/database inventory.

The enforced sequence is:

1. Acquire the exclusive OS rollout lock.
2. Verify the root-owned config, selected units from the compiled seven-unit allowlist, clean `main`, and the exact expected commit. Every Git command runs as the runtime user.
3. Resolve each selected unit's effective `DB_PATH` or `HEALTH_DB_PATH` using shared-then-unit environment-file precedence. Reject defaults, unknown units, missing files, non-canonical paths, duplicates, inventory mismatches, unknown schemas, integrity failures, or nonzero legacy queues.
4. Stop every service and prove each is inactive.
5. Recheck Git and database preconditions.
6. Create byte-exact SQLite backups after proving no WAL/SHM sidecars remain. Record and verify source/backup UID, GID, mode, size, canonical path, and SHA-256.
7. Run the repository's additive migrations and validate the current schema.
8. Start every service, verify active state, inspect startup error logs, and revalidate databases.

Every phase writes a timestamped log plus JSON evidence and SHA-256 manifests beneath pre-existing, canonical, root-owned directories. A failure before the first start attempt restores every database through a securely created temporary file, atomically replaces it, reapplies the original metadata, verifies the result, and leaves services stopped. A failure during or after a start attempt stops all services, preserves migrated databases and evidence, and requires operator review. The helper deliberately does not attempt an automatic post-start code/database rollback.

## Installation

Review and install the helper and fixed inventory as root:

```bash
sudo install -D -m 0750 -o root -g root scripts/rollout-agent-bridge.sh /usr/local/sbin/rollout-agent-bridge
sudo install -d -m 0700 -o root -g root /var/backups/agent-bridge /var/log/agent-bridge-rollouts
sudo install -D -m 0600 -o root -g root systemd/agent-bridge-rollout.conf.example /etc/agent-bridge/rollout.conf
sudoedit /etc/agent-bridge/rollout.conf
sudo visudo -f /etc/sudoers.d/agent-bridge-rollout
```

Sudoers content:

```sudoers
content-crawler ALL=(root) NOPASSWD: /usr/local/sbin/rollout-agent-bridge
```

The config must remain `root:root` and must not be group/world writable. Select a fixed subset of the compiled unit allowlist and list the exact canonical, non-symlink database set those units resolve from `/etc/default/agent-bridge-shared` followed by their unit-specific environment file. Multiple units may intentionally share one database; duplicate `database=` entries are forbidden. The helper aborts if discovery and the allowlist differ. `backup_dir` and `log_dir` must already exist as canonical, root-owned directories with no group/world write bits.

## Authorized invocation

Only after separate production approval:

```bash
sudo -n /usr/local/sbin/rollout-agent-bridge --expected-commit <full-40-character-main-sha>
```

Artifacts are written beneath the configured `log_dir`; database snapshots are written beneath `backup_dir`. On any failure, keep services stopped and inspect the newest artifact path recorded in `log_dir/latest` before taking further action.

Legacy queue discard is intentionally unsupported. A nonzero legacy queue count aborts before service stop and requires a separate explicit operational decision and tool.
