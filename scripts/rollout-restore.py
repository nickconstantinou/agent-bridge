#!/usr/bin/python3
"""Descriptor-only database restore primitive for rollout-agent-bridge."""

from __future__ import annotations

import argparse
import hashlib
import os
import secrets
import stat
import sys
from typing import NoReturn


def fail(message: str) -> NoReturn:
    raise RuntimeError(message)


def digest_fd(fd: int) -> tuple[int, str]:
    os.lseek(fd, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    size = 0
    while chunk := os.read(fd, 1024 * 1024):
        digest.update(chunk)
        size += len(chunk)
    return size, digest.hexdigest()


def same_inode(left: os.stat_result, right: os.stat_result) -> bool:
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--backup", required=True)
    parser.add_argument("--uid", required=True, type=int)
    parser.add_argument("--gid", required=True, type=int)
    parser.add_argument("--mode", required=True)
    parser.add_argument("--size", required=True, type=int)
    parser.add_argument("--sha256", required=True)
    return parser.parse_args()


def restore(args: argparse.Namespace) -> None:
    source = os.path.abspath(args.source)
    backup = os.path.abspath(args.backup)
    source_dir, source_name = os.path.split(source)
    if not source_name or source != args.source or backup != args.backup:
        fail("source and backup must be canonical absolute paths")
    if len(args.sha256) != 64 or any(character not in "0123456789abcdef" for character in args.sha256):
        fail("invalid expected SHA-256")
    mode = int(args.mode, 8)
    if mode < 0 or mode > 0o7777:
        fail("invalid expected mode")

    directory_fd = os.open(source_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    backup_fd = -1
    source_fd = -1
    temporary_fd = -1
    temporary_name = ""
    try:
        backup_fd = os.open(backup, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        source_fd = os.open(source_name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory_fd)
        if not stat.S_ISREG(os.fstat(backup_fd).st_mode) or not stat.S_ISREG(os.fstat(source_fd).st_mode):
            fail("source and backup must be regular files")
        backup_size, backup_hash = digest_fd(backup_fd)
        if backup_size != args.size or backup_hash != args.sha256:
            fail("backup size or SHA-256 mismatch")

        for _ in range(128):
            temporary_name = f".agent-bridge-restore.{secrets.token_hex(16)}"
            try:
                temporary_fd = os.open(
                    temporary_name,
                    os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                    0o600,
                    dir_fd=directory_fd,
                )
                break
            except FileExistsError:
                continue
        if temporary_fd < 0:
            fail("cannot create exclusive restore file")
        temporary_stat = os.fstat(temporary_fd)

        substitution_target = os.environ.get("AGENT_BRIDGE_RESTORE_TEST_SWAP_TARGET")
        if substitution_target:
            if os.geteuid() == 0:
                fail("restore test hook is forbidden during root execution")
            os.unlink(temporary_name, dir_fd=directory_fd)
            os.symlink(substitution_target, temporary_name, dir_fd=directory_fd)

        os.lseek(backup_fd, 0, os.SEEK_SET)
        while chunk := os.read(backup_fd, 1024 * 1024):
            view = memoryview(chunk)
            while view:
                written = os.write(temporary_fd, view)
                if written <= 0:
                    fail("short write while restoring database")
                view = view[written:]
        os.fchown(temporary_fd, args.uid, args.gid)
        os.fchmod(temporary_fd, mode)
        os.fsync(temporary_fd)
        restored_size, restored_hash = digest_fd(temporary_fd)
        restored_stat = os.fstat(temporary_fd)
        if (
            restored_size != args.size
            or restored_hash != args.sha256
            or restored_stat.st_uid != args.uid
            or restored_stat.st_gid != args.gid
            or stat.S_IMODE(restored_stat.st_mode) != mode
        ):
            fail("descriptor restore verification failed")

        path_stat = os.stat(temporary_name, dir_fd=directory_fd, follow_symlinks=False)
        if not same_inode(path_stat, temporary_stat):
            fail("active substitution detected for restore file")
        os.rename(
            temporary_name,
            source_name,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
        )
        temporary_name = ""
        os.fsync(directory_fd)
        final_stat = os.fstat(temporary_fd)
        final_size, final_hash = digest_fd(temporary_fd)
        if (
            final_size != args.size
            or final_hash != args.sha256
            or final_stat.st_uid != args.uid
            or final_stat.st_gid != args.gid
            or stat.S_IMODE(final_stat.st_mode) != mode
        ):
            fail("atomic restore verification failed")
    finally:
        if temporary_name and temporary_fd >= 0:
            try:
                path_stat = os.stat(temporary_name, dir_fd=directory_fd, follow_symlinks=False)
                if same_inode(path_stat, os.fstat(temporary_fd)):
                    os.unlink(temporary_name, dir_fd=directory_fd)
            except FileNotFoundError:
                pass
        for fd in (temporary_fd, source_fd, backup_fd, directory_fd):
            if fd >= 0:
                os.close(fd)


def main() -> int:
    try:
        restore(parse_args())
    except (OSError, RuntimeError, ValueError) as error:
        print(f"rollout-restore: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
