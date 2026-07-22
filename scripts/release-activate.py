#!/usr/bin/env python3
"""Atomically activate one previously staged immutable release.

This helper only publishes the ``current`` symlink. It does not stop or start
services, modify databases, or perform migrations. The caller owns the guarded
service/database state machine and must hold its rollout lock.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path


SHA = 40


def fail(message: str) -> None:
    raise RuntimeError(message)


def production_mode() -> bool:
    return os.environ.get("AGENT_BRIDGE_RELEASE_ACTIVATE_TEST") != "1"


def validate_commit(commit: str) -> None:
    if len(commit) != SHA or any(char not in "0123456789abcdef" for char in commit):
        fail("expected commit must be a full lowercase 40-character SHA")


def validate_release_root(path: Path) -> Path:
    if path.is_symlink() or not path.is_dir():
        fail("release root must be a regular directory, not a symlink")
    metadata = path.stat()
    if production_mode() and (metadata.st_uid != 0 or metadata.st_mode & 0o022):
        fail("production release root must be root-owned and not group/world writable")
    return path


def validate_release(release: Path, expected_commit: str) -> None:
    if release.is_symlink() or not release.is_dir():
        fail("target release must be an immutable regular directory")
    manifest_path = release / "manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        fail("target release is missing a regular manifest.json")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"invalid target release manifest: {error}")
    if manifest.get("schema_version") != 1 or manifest.get("commit") != expected_commit:
        fail("target release manifest identity does not match expected commit")

    for current, directories, files in os.walk(release, followlinks=False):
        for name in directories + files:
            path = Path(current) / name
            if path.is_symlink():
                target = os.readlink(path)
                if os.path.isabs(target) or (path.parent / target).resolve() != release and release not in (path.parent / target).resolve().parents:
                    fail(f"target release contains an escaping symlink: {path}")
                continue
            mode = path.stat().st_mode
            if mode & 0o222:
                fail(f"target release is writable: {path}")
    if release.stat().st_mode & 0o222:
        fail("target release directory is writable")


def current_target(current: Path, release_root: Path) -> str | None:
    if not current.exists() and not current.is_symlink():
        return None
    if not current.is_symlink():
        fail("current pointer must be a symlink or absent")
    target = os.readlink(current)
    if os.path.isabs(target) or Path(target).name != target:
        fail("current pointer target must be a relative release name")
    previous = release_root / target
    if target == "current" or previous.is_symlink() or not previous.is_dir():
        fail("current pointer does not resolve to a release directory")
    return target


def activate(release_root: Path, current: Path, expected_commit: str) -> str:
    validate_commit(expected_commit)
    release_root = validate_release_root(release_root)
    if current.parent != release_root or current.name != "current":
        fail("current pointer must be release-root/current")
    validate_release(release_root / expected_commit, expected_commit)
    previous = current_target(current, release_root)

    descriptor, temporary_name = tempfile.mkstemp(prefix=".current-", dir=release_root)
    os.close(descriptor)
    temporary = Path(temporary_name)
    temporary.unlink()
    try:
        os.symlink(expected_commit, temporary)
        os.replace(temporary, current)
    finally:
        if temporary.is_symlink() or temporary.exists():
            temporary.unlink()
    if previous:
        return f"activated {expected_commit} (previous {previous})"
    return f"activated {expected_commit} (previous none)"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release-root", type=Path, required=True)
    parser.add_argument("--current", type=Path, required=True)
    parser.add_argument("--expected-commit", required=True)
    args = parser.parse_args()
    if os.geteuid() != 0 and production_mode():
        fail("release activation must run as root")
    print(activate(args.release_root, args.current, args.expected_commit))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"release-activate: {error}", file=sys.stderr)
        raise SystemExit(1)
