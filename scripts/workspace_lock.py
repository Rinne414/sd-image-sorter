"""Cross-process workspace lock shared by CI and Playwright writers."""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO, Iterator, Mapping, Sequence, TypedDict, cast

LOCK_BYTE_OFFSET = 4096
LOCK_SCHEMA_VERSION = 1
CANONICAL_WORKSPACE_LOCK_SCOPE = "ci-playwright-canonical"
CAPABILITY_ENV_NAME = "PW_WORKSPACE_LOCK_CAPABILITY"
HOLDER_PID_ENV_NAME = "PW_WORKSPACE_LOCK_HOLDER_PID"
RUN_ID_ENV_NAME = "PW_WORKSPACE_LOCK_RUN_ID"

_IDENTITY_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_CONTENTION_ERRNOS = frozenset({errno.EACCES, errno.EAGAIN, errno.EDEADLK})
_WINDOWS_LOCK_VIOLATION = 33


class WorkspaceLockError(RuntimeError):
    """Raised when a workspace lock cannot be acquired, verified, or released."""


class WorkspaceLockBusyError(WorkspaceLockError):
    """Raised when another process owns a requested workspace lock."""


class WorkspaceLockOwner(TypedDict):
    schemaVersion: int
    scope: str
    holderPid: int
    runId: str
    startedAt: str
    capabilitySha256: str


def _require_identity(value: str, field_name: str) -> str:
    if not isinstance(value, str) or not _IDENTITY_PATTERN.fullmatch(value):
        raise ValueError(
            f"{field_name} must match /^[A-Za-z0-9][A-Za-z0-9._-]{{0,127}}$/"
        )
    return value


def hash_capability(capability: str) -> str:
    if not isinstance(capability, str) or len(capability) < 32:
        raise ValueError("workspace lock capability must contain at least 32 characters")
    return hashlib.sha256(capability.encode("utf-8")).hexdigest()


def build_lock_owner(
    scope: str,
    holder_pid: int,
    run_id: str,
    capability: str,
    started_at: str,
) -> WorkspaceLockOwner:
    _require_identity(scope, "scope")
    _require_identity(run_id, "run_id")
    if type(holder_pid) is not int or holder_pid < 1:
        raise ValueError("holder_pid must be a positive integer")
    if not isinstance(started_at, str) or not started_at:
        raise ValueError("started_at must be a non-empty string")
    try:
        parsed_started_at = datetime.fromisoformat(started_at)
    except ValueError as error:
        raise ValueError("started_at must be an ISO-8601 timestamp") from error
    if parsed_started_at.tzinfo is None:
        raise ValueError("started_at must include a timezone")
    return {
        "schemaVersion": LOCK_SCHEMA_VERSION,
        "scope": scope,
        "holderPid": holder_pid,
        "runId": run_id,
        "startedAt": started_at,
        "capabilitySha256": hash_capability(capability),
    }


def create_lock_owner(
    scope: str,
    holder_pid: int,
    run_id: str,
    capability: str,
) -> WorkspaceLockOwner:
    started_at = datetime.now(timezone.utc).isoformat()
    return build_lock_owner(scope, holder_pid, run_id, capability, started_at)


def validate_lock_owner(value: object, lock_path: Path) -> WorkspaceLockOwner:
    if not isinstance(value, dict):
        raise WorkspaceLockError(f"workspace lock owner must be a JSON object: {lock_path}")
    required_fields = (
        "schemaVersion",
        "scope",
        "holderPid",
        "runId",
        "startedAt",
        "capabilitySha256",
    )
    missing_fields = [field for field in required_fields if field not in value]
    if missing_fields:
        raise WorkspaceLockError(
            f"workspace lock owner is missing {', '.join(missing_fields)}: {lock_path}"
        )
    if type(value["schemaVersion"]) is not int or value["schemaVersion"] != LOCK_SCHEMA_VERSION:
        raise WorkspaceLockError(
            f"workspace lock owner has unsupported schemaVersion: {lock_path}"
        )
    scope = value["scope"]
    run_id = value["runId"]
    holder_pid = value["holderPid"]
    started_at = value["startedAt"]
    capability_sha256 = value["capabilitySha256"]
    try:
        _require_identity(cast(str, scope), "scope")
        _require_identity(cast(str, run_id), "runId")
    except (TypeError, ValueError) as error:
        raise WorkspaceLockError(f"workspace lock owner identity is invalid: {lock_path}") from error
    if type(holder_pid) is not int or holder_pid < 1:
        raise WorkspaceLockError(f"workspace lock owner holderPid is invalid: {lock_path}")
    if not isinstance(started_at, str) or not started_at:
        raise WorkspaceLockError(f"workspace lock owner startedAt is invalid: {lock_path}")
    try:
        parsed_started_at = datetime.fromisoformat(started_at)
    except ValueError as error:
        raise WorkspaceLockError(
            f"workspace lock owner startedAt is not ISO-8601: {lock_path}"
        ) from error
    if parsed_started_at.tzinfo is None:
        raise WorkspaceLockError(
            f"workspace lock owner startedAt has no timezone: {lock_path}"
        )
    if not isinstance(capability_sha256, str) or not _SHA256_PATTERN.fullmatch(
        capability_sha256
    ):
        raise WorkspaceLockError(
            f"workspace lock owner capabilitySha256 is invalid: {lock_path}"
        )
    return {
        "schemaVersion": LOCK_SCHEMA_VERSION,
        "scope": cast(str, scope),
        "holderPid": holder_pid,
        "runId": cast(str, run_id),
        "startedAt": started_at,
        "capabilitySha256": capability_sha256,
    }


def _lock_file(handle: BinaryIO) -> None:
    handle.seek(LOCK_BYTE_OFFSET)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        return

    import fcntl

    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock_file(handle: BinaryIO) -> None:
    handle.seek(LOCK_BYTE_OFFSET)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        return

    import fcntl

    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _is_lock_contention(error: OSError) -> bool:
    return (
        isinstance(error, BlockingIOError)
        or error.errno in _CONTENTION_ERRNOS
        or getattr(error, "winerror", None) == _WINDOWS_LOCK_VIOLATION
    )


def _ensure_lock_byte(handle: BinaryIO) -> None:
    handle.seek(0, os.SEEK_END)
    if handle.tell() <= LOCK_BYTE_OFFSET:
        handle.seek(LOCK_BYTE_OFFSET)
        handle.write(b"\0")
        handle.flush()


def _open_lock_handle(lock_path: Path) -> BinaryIO:
    if not lock_path.is_absolute():
        raise ValueError(f"workspace lock path must be absolute: {lock_path}")
    try:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        return os.fdopen(descriptor, "r+b", buffering=0)
    except OSError as error:
        raise WorkspaceLockError(
            f"failed to open workspace lock file {lock_path}: {error}"
        ) from error


def _try_lock(handle: BinaryIO, lock_path: Path) -> bool:
    try:
        _lock_file(handle)
    except OSError as error:
        if _is_lock_contention(error):
            return False
        raise WorkspaceLockError(
            f"failed to acquire workspace lock {lock_path}: {error}"
        ) from error
    return True


def _read_lock_owner(handle: BinaryIO, lock_path: Path) -> WorkspaceLockOwner:
    try:
        handle.seek(0)
        raw_owner = handle.read(LOCK_BYTE_OFFSET).rstrip(b"\0").decode("utf-8")
    except (OSError, UnicodeError) as error:
        raise WorkspaceLockError(
            f"workspace lock owner is unreadable at {lock_path}: {error}"
        ) from error
    if not raw_owner:
        raise WorkspaceLockError(f"workspace lock owner is empty: {lock_path}")
    try:
        value = json.loads(raw_owner)
    except json.JSONDecodeError as error:
        raise WorkspaceLockError(
            f"workspace lock owner is invalid JSON at {lock_path}: {error}"
        ) from error
    return validate_lock_owner(value, lock_path)


def _write_lock_owner(
    handle: BinaryIO,
    lock_path: Path,
    owner: WorkspaceLockOwner,
) -> None:
    owner_bytes = json.dumps(owner, separators=(",", ":"), sort_keys=True).encode("utf-8")
    if len(owner_bytes) >= LOCK_BYTE_OFFSET:
        raise ValueError("workspace lock owner record exceeds the reserved header size")
    try:
        handle.seek(0)
        handle.write(owner_bytes)
        handle.write(b"\0" * (LOCK_BYTE_OFFSET - len(owner_bytes)))
        handle.seek(LOCK_BYTE_OFFSET)
        handle.write(b"\0")
        handle.truncate(LOCK_BYTE_OFFSET + 1)
        handle.flush()
        os.fsync(handle.fileno())
    except OSError as error:
        raise WorkspaceLockError(
            f"failed to publish workspace lock owner at {lock_path}: {error}"
        ) from error


def _format_safe_owner(owner: WorkspaceLockOwner) -> str:
    return json.dumps(owner, separators=(",", ":"), sort_keys=True)


@contextmanager
def exclusive_workspace_lock(
    lock_path: Path,
    owner: WorkspaceLockOwner,
    lock_label: str,
) -> Iterator[WorkspaceLockOwner]:
    if not isinstance(lock_label, str) or not lock_label:
        raise ValueError("lock_label must be a non-empty string")
    normalized_owner = validate_lock_owner(owner, lock_path)
    handle = _open_lock_handle(lock_path)
    locked = False
    try:
        _ensure_lock_byte(handle)
        if not _try_lock(handle, lock_path):
            current_owner = _read_lock_owner(handle, lock_path)
            raise WorkspaceLockBusyError(
                f"{lock_label} lock is already owned; wait for it to finish. "
                f"lock={lock_path}, owner={_format_safe_owner(current_owner)}"
            )
        locked = True
        _write_lock_owner(handle, lock_path, normalized_owner)
        yield normalized_owner
    finally:
        active_error = sys.exception()
        unlock_error: OSError | None = None
        try:
            if locked:
                _unlock_file(handle)
        except OSError as error:
            unlock_error = error
        finally:
            handle.close()
        if unlock_error is not None:
            message = f"failed to release {lock_label} lock {lock_path}: {unlock_error}"
            if active_error is not None:
                active_error.add_note(message)
            else:
                raise WorkspaceLockError(message) from unlock_error


def verify_inherited_workspace_lock(
    lock_path: Path,
    expected_scope: str,
    expected_holder_pid: int,
    expected_run_id: str,
    capability: str,
) -> WorkspaceLockOwner:
    _require_identity(expected_scope, "expected_scope")
    _require_identity(expected_run_id, "expected_run_id")
    if type(expected_holder_pid) is not int or expected_holder_pid < 1:
        raise ValueError("expected_holder_pid must be a positive integer")
    expected_capability_sha256 = hash_capability(capability)
    handle = _open_lock_handle(lock_path)
    acquired = False
    try:
        _ensure_lock_byte(handle)
        acquired = _try_lock(handle, lock_path)
        if acquired:
            raise WorkspaceLockError(
                f"cannot inherit workspace lock because it is not currently held: {lock_path}"
            )
        owner = _read_lock_owner(handle, lock_path)
        expected_fields = {
            "scope": expected_scope,
            "holderPid": expected_holder_pid,
            "runId": expected_run_id,
            "capabilitySha256": expected_capability_sha256,
        }
        mismatched_fields = [
            field_name
            for field_name, expected_value in expected_fields.items()
            if owner[field_name] != expected_value
        ]
        if mismatched_fields:
            raise WorkspaceLockError(
                "inherited workspace lock owner mismatch for "
                f"{', '.join(mismatched_fields)}; lock={lock_path}, "
                f"owner={_format_safe_owner(owner)}"
            )
        if _try_lock(handle, lock_path):
            acquired = True
            raise WorkspaceLockError(
                f"workspace lock was released during inherited-owner verification: {lock_path}"
            )
        return owner
    finally:
        active_error = sys.exception()
        unlock_error: OSError | None = None
        try:
            if acquired:
                _unlock_file(handle)
        except OSError as error:
            unlock_error = error
        finally:
            handle.close()
        if unlock_error is not None:
            message = f"failed to release inherited workspace lock probe {lock_path}: {unlock_error}"
            if active_error is not None:
                active_error.add_note(message)
            else:
                raise WorkspaceLockError(message) from unlock_error


def run_locked_command(
    lock_path: Path,
    scope: str,
    run_id: str,
    command: Sequence[str],
    environment: Mapping[str, str],
) -> int:
    if not command or any(not isinstance(part, str) or not part for part in command):
        raise ValueError("locked command must contain non-empty string arguments")
    capability = secrets.token_hex(32)
    owner = create_lock_owner(scope, os.getpid(), run_id, capability)
    child_environment = dict(environment)
    child_environment[CAPABILITY_ENV_NAME] = capability
    child_environment[HOLDER_PID_ENV_NAME] = str(os.getpid())
    child_environment[RUN_ID_ENV_NAME] = run_id
    with exclusive_workspace_lock(
        lock_path,
        owner,
        "CI/Playwright canonical workspace",
    ):
        result = subprocess.run(list(command), env=child_environment, check=False)
    return result.returncode if result.returncode >= 0 else 128 + abs(result.returncode)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)
    run_parser = subparsers.add_parser("run")
    run_parser.add_argument("--lock-path", required=True)
    run_parser.add_argument("--scope", required=True)
    run_parser.add_argument("--run-id", required=True)
    run_parser.add_argument("command", nargs=argparse.REMAINDER)
    verify_parser = subparsers.add_parser("verify")
    verify_parser.add_argument("--lock-path", required=True)
    verify_parser.add_argument("--scope", required=True)
    verify_parser.add_argument("--run-id", required=True)
    verify_parser.add_argument("--holder-pid", required=True, type=int)
    return parser


def main(argv: Sequence[str], environment: Mapping[str, str]) -> int:
    args = _build_parser().parse_args(list(argv))
    try:
        lock_path = Path(args.lock_path).resolve()
        if args.action == "run":
            command = list(args.command)
            if command and command[0] == "--":
                command = command[1:]
            return run_locked_command(
                lock_path,
                args.scope,
                args.run_id,
                command,
                environment,
            )
        capability = environment.get(CAPABILITY_ENV_NAME, "")
        owner = verify_inherited_workspace_lock(
            lock_path,
            args.scope,
            args.holder_pid,
            args.run_id,
            capability,
        )
        print(json.dumps({"status": "verified", "owner": owner}, sort_keys=True))
        return 0
    except (OSError, subprocess.SubprocessError, ValueError, WorkspaceLockError) as error:
        print(f"[workspace-lock] ERROR: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("[workspace-lock] ERROR: interrupted while holding workspace lock", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:], os.environ))
