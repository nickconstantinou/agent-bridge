# Controlled current-release pointer

This is the second server-side slice of Issue #183. It adds the narrow pointer
publication boundary between immutable release staging and a later guarded
service/database rollout.

## Installation

Install the activation helper outside the Git checkout as a root-owned
executable:

```bash
sudo install -D -o root -g root -m 0750 \
  scripts/release-activate.py /usr/local/libexec/agent-bridge-release-activate
```

Configure `/etc/default/agent-bridge-release` from
`systemd/agent-bridge-release.conf.example`. Its
`BRIDGE_CURRENT_RELEASE_DIR` must be the `current` symlink below the validated
release root, not a Git checkout or a release directory directly.

## Activation contract

The helper validates the exact target commit, its manifest identity, release
directory ownership/mode, and that all release entries are non-writable before
it creates a temporary symlink in the same release root. It then publishes the
temporary symlink with `os.replace`, so an interruption leaves either the old
pointer or the new pointer rather than a partially written path.

The caller must hold the guarded rollout lock and must complete service
containment, WAL draining, backup, and migration checks before invoking it:

```bash
sudo -n /usr/local/libexec/agent-bridge-release-activate \
  --release-root /opt/agent-bridge/releases \
  --current /opt/agent-bridge/releases/current \
  --expected-commit <full-40-character-commit-sha>
```

This helper does not stop or start services, touch SQLite databases or queues,
run migrations, or perform rollback. It is safe to stage and test without
production activation.

The guarded rollout helper accepts `release_root` and `current_pointer` in its
root-owned rollout configuration. When both are present it validates the
pointer and active release before any service stop, and uses that immutable
release for migration tooling. A mutable `project_dir` is retained only for
the legacy checkout mode and is not required in release mode.

## systemd boundary

All Agent Bridge service templates load the release pointer environment and
refuse to start unless `BRIDGE_CURRENT_RELEASE_DIR` is a symlink containing a
regular `manifest.json`. Once the pointer is validated, the service exports it
as `BRIDGE_PROJECT_DIR` so application code, soul/config lookup, and CLI
working-directory resolution all use the active immutable release.
