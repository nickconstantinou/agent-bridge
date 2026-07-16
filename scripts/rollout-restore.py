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
    parser.add_argument("--parent-device", required=True, type=int)
    parser.add_argument("--parent-inode", required=True, type=int)
    parser.add_argument("--parent-uid", required=True, type=int)
    parser.add_argument("--parent-gid", required=True, type=int)
    parser.add_argument("--parent-mode", required=True)
    return parser.parse_args()


def test_value(name: str, test_mode: bool) -> str | None:
    value = os.environ.get(name)
    if value and not test_mode:
        fail(f"{name} is forbidden outside restore test mode")
    return value


def attempt_substitution_as_user(
    directory_fd: int,
    temporary_name: str,
    target: str,
    uid: int,
    gid: int,
) -> None:
    pid = os.fork()
    if pid == 0:
        try:
            os.setgroups([])
            os.setgid(gid)
            os.setuid(uid)
            os.unlink(temporary_name, dir_fd=directory_fd)
            os.symlink(target, temporary_name, dir_fd=directory_fd)
        except PermissionError:
            os._exit(77)
        except OSError:
            os._exit(78)
        os._exit(0)
    _, status = os.waitpid(pid, 0)
    result = os.waitstatus_to_exitcode(status)
    if result == 0:
        fail("runtime-user substitution unexpectedly succeeded")
    if result != 77:
        fail(f"runtime-user substitution probe failed unexpectedly: {result}")


def restore(args: argparse.Namespace) -> None:
    source = os.path.abspath(args.source)
    backup = os.path.abspath(args.backup)
    source_dir, source_name = os.path.split(source)
    if not source_name or source != args.source or backup != args.backup:
        fail("source and backup must be canonical absolute paths")
    if len(args.sha256) != 64 or any(character not in "0123456789abcdef" for character in args.sha256):
        fail("invalid expected SHA-256")
    mode = int(args.mode, 8)
    parent_mode = int(args.parent_mode, 8)
    if mode < 0 or mode > 0o7777:
        fail("invalid expected mode")
    if parent_mode < 0 or parent_mode > 0o7777:
        fail("invalid expected parent mode")

    test_mode = os.environ.get("AGENT_BRIDGE_RESTORE_TEST_MODE") == "1"
    if os.geteuid() != 0:
        fail("restore helper must run as root")
    if test_mode and not source.startswith("/tmp/"):
        fail("restore test mode is restricted to /tmp")
    try:
        parent_path_stat = os.lstat(source_dir)
    except OSError as error:
        fail(f"cannot inspect source parent: {error}")
    if stat.S_ISLNK(parent_path_stat.st_mode):
        fail("source parent must not be a symlink")

    try:
        directory_fd = os.open(
            source_dir,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
        )
    except OSError as error:
        fail(f"cannot open source parent without following symlinks: {error}")
    backup_fd = -1
    source_fd = -1
    temporary_fd = -1
    temporary_name = ""
    directory_mode_changed = False
    directory_restore_error: RuntimeError | None = None
    try:
        directory_stat = os.fstat(directory_fd)
        if directory_stat.st_dev != args.parent_device or directory_stat.st_ino != args.parent_inode:
            fail("parent directory identity mismatch")
        if (
            directory_stat.st_uid != args.parent_uid
            or directory_stat.st_gid != args.parent_gid
            or stat.S_IMODE(directory_stat.st_mode) != parent_mode
        ):
            fail("parent directory metadata mismatch")
        backup_fd = os.open(backup, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        source_fd = os.open(source_name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory_fd)
        if not stat.S_ISREG(os.fstat(backup_fd).st_mode) or not stat.S_ISREG(os.fstat(source_fd).st_mode):
            fail("source and backup must be regular files")
        backup_size, backup_hash = digest_fd(backup_fd)
        if backup_size != args.size or backup_hash != args.sha256:
            fail("backup size or SHA-256 mismatch")

        write_disabled_mode = parent_mode & ~0o222
        os.fchmod(directory_fd, write_disabled_mode)
        directory_mode_changed = True
        if stat.S_IMODE(os.fstat(directory_fd).st_mode) != write_disabled_mode:
            fail("cannot verify source parent write disable")
        if test_value("AGENT_BRIDGE_RESTORE_TEST_FAIL_STAGE", test_mode) == "after-write-disable":
            fail("injected failure after source parent write disable")

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

        substitution_target = test_value("AGENT_BRIDGE_RESTORE_TEST_SWAP_TARGET", test_mode)
        substitution_stage = test_value("AGENT_BRIDGE_RESTORE_TEST_SWAP_STAGE", test_mode)
        if substitution_target and substitution_stage == "after-create":
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
        if substitution_target and substitution_stage == "after-inode-check":
            attacker_uid = int(test_value("AGENT_BRIDGE_RESTORE_TEST_ATTACKER_UID", test_mode) or args.uid)
            attacker_gid = int(test_value("AGENT_BRIDGE_RESTORE_TEST_ATTACKER_GID", test_mode) or args.gid)
            attempt_substitution_as_user(
                directory_fd,
                temporary_name,
                substitution_target,
                attacker_uid,
                attacker_gid,
            )
        os.rename(
            temporary_name,
            source_name,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
        )
        temporary_name = ""
        os.fsync(directory_fd)
        final_target = test_value("AGENT_BRIDGE_RESTORE_TEST_FINAL_TARGET", test_mode)
        if final_target:
            os.unlink(source_name, dir_fd=directory_fd)
            os.symlink(final_target, source_name, dir_fd=directory_fd)
        final_path_stat = os.stat(source_name, dir_fd=directory_fd, follow_symlinks=False)
        if not same_inode(final_path_stat, os.fstat(temporary_fd)):
            fail("final destination inode mismatch")
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
        if directory_mode_changed:
            try:
                os.fchmod(directory_fd, parent_mode)
                if stat.S_IMODE(os.fstat(directory_fd).st_mode) != parent_mode:
                    raise OSError("restored mode verification mismatch")
                os.fsync(directory_fd)
            except OSError as error:
                directory_restore_error = RuntimeError(f"cannot restore source parent mode: {error}")
        for fd in (temporary_fd, source_fd, backup_fd, directory_fd):
            if fd >= 0:
                os.close(fd)
        if directory_restore_error:
            raise directory_restore_error


def main() -> int:
    try:
        restore(parse_args())
    except (OSError, RuntimeError, ValueError) as error:
        print(f"rollout-restore: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
