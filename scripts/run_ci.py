#!/usr/bin/env python3
"""Minimal CI entrypoint for sd-image-sorter release work."""

from __future__ import annotations

import subprocess
import sys
import os
import json
import re
import shutil
import socket
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO, Iterator

ROOT = Path(__file__).resolve().parent.parent


def _first_existing(*candidates: Path) -> Path | None:
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


_BACKEND_PYTHON = _first_existing(
    ROOT / "backend" / "venv" / "Scripts" / "python.exe",
    ROOT / "backend" / "venv" / "bin" / "python",
)
BACKEND_PYTHON = _BACKEND_PYTHON or Path(sys.executable)
E2E_PLAYWRIGHT = _first_existing(
    ROOT / "tests" / "e2e" / "node_modules" / ".bin" / "playwright.cmd",
    ROOT / "tests" / "e2e" / "node_modules" / ".bin" / "playwright",
)
PLAYWRIGHT_CLI = ROOT / "tests" / "e2e" / "node_modules" / "playwright" / "cli.js"
PLAYWRIGHT_WRAPPER = ROOT / "tests" / "e2e" / "scripts" / "run-playwright.mjs"
REVIEW_DATASET_BUILDER = ROOT / "scripts" / "build_review_dataset.py"
FRONTEND_JS_FILES = sorted((ROOT / "frontend" / "js").glob("**/*.js"))
CI_LOCK_PATH = ROOT / ".tmp" / "run-ci.lock"
CI_LOCK_BYTE_OFFSET = 4096
CI_SHARD_COUNT_PATTERN = re.compile(r"^[0-9]+$")
CI_MIN_SHARD_COUNT = 2
CI_MAX_SHARD_COUNT = 8


class CiLockError(RuntimeError):
    """Raised when another full CI invocation owns the workspace lock."""


def _lock_file(handle: BinaryIO) -> None:
    handle.seek(CI_LOCK_BYTE_OFFSET)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        return

    import fcntl

    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock_file(handle: BinaryIO) -> None:
    handle.seek(CI_LOCK_BYTE_OFFSET)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        return

    import fcntl

    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _read_lock_owner(handle: BinaryIO, lock_path: Path) -> str:
    try:
        handle.seek(0)
        raw_owner = handle.read(CI_LOCK_BYTE_OFFSET).rstrip(b"\0").decode("utf-8")
    except (OSError, UnicodeError) as error:
        return f"unreadable owner ({error})"
    return raw_owner or f"unknown owner in {lock_path}"


@contextmanager
def _exclusive_ci_lock(lock_path: Path, run_id: str) -> Iterator[None]:
    if not run_id:
        raise ValueError("run_id must be a non-empty string")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    handle = os.fdopen(descriptor, "r+b", buffering=0)
    locked = False
    try:
        handle.seek(0, os.SEEK_END)
        if handle.tell() <= CI_LOCK_BYTE_OFFSET:
            handle.seek(CI_LOCK_BYTE_OFFSET)
            handle.write(b"\0")
            handle.flush()
        try:
            _lock_file(handle)
        except OSError as error:
            owner = _read_lock_owner(handle, lock_path)
            raise CiLockError(
                "another full CI invocation owns the workspace coverage lock; "
                f"wait for it to finish. lock={lock_path}, owner={owner}"
            ) from error
        locked = True
        owner = json.dumps({"pid": os.getpid(), "runId": run_id})
        owner_bytes = owner.encode("utf-8")
        if len(owner_bytes) >= CI_LOCK_BYTE_OFFSET:
            raise ValueError("CI lock owner record exceeds the reserved header size")
        handle.seek(0)
        handle.write(owner_bytes)
        handle.write(b"\0" * (CI_LOCK_BYTE_OFFSET - len(owner_bytes)))
        handle.seek(CI_LOCK_BYTE_OFFSET)
        handle.write(b"\0")
        handle.truncate(CI_LOCK_BYTE_OFFSET + 1)
        handle.flush()
        os.fsync(handle.fileno())
        yield
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
            message = (
                f"failed to release full CI workspace lock {lock_path}: "
                f"{unlock_error}"
            )
            if active_error is not None:
                active_error.add_note(message)
            else:
                raise CiLockError(message) from unlock_error


def _create_coverage_run_id() -> str:
    return f"ci-{uuid.uuid4().hex}"


def _require_sharded_full_ci(environment: dict[str, str]) -> None:
    incompatible: list[str] = []
    if environment.get("PW_DISABLE_SHARDING") == "1":
        incompatible.append("PW_DISABLE_SHARDING=1")
    raw_shard_count = environment.get("PW_SHARD_COUNT")
    if raw_shard_count not in (None, ""):
        valid_count = CI_SHARD_COUNT_PATTERN.fullmatch(raw_shard_count)
        shard_count = int(raw_shard_count) if valid_count else 0
        if not CI_MIN_SHARD_COUNT <= shard_count <= CI_MAX_SHARD_COUNT:
            incompatible.append(f"PW_SHARD_COUNT={raw_shard_count}")
    for name in ("BASE_URL", "SD_IMAGE_SORTER_PORT"):
        value = environment.get(name)
        if value:
            incompatible.append(f"{name}={value}")
    if incompatible:
        raise ValueError(
            "full CI click coverage requires sharded Playwright; unset "
            + ", ".join(incompatible)
        )


def _first_executable(*candidates: str | Path) -> str:
    for candidate in candidates:
        if isinstance(candidate, Path):
            if candidate.exists():
                return str(candidate)
        else:
            found = shutil.which(candidate)
            if found:
                return found
    return str(candidates[0])


NODE_EXECUTABLE = _first_executable(
    *(
        [
            Path("/mnt/c/Program Files/nodejs/node.exe"),
            Path("C:/Program Files/nodejs/node.exe"),
            "node",
            Path("/usr/bin/node"),
            Path("/usr/local/bin/node"),
        ]
        if str(BACKEND_PYTHON).lower().endswith(".exe")
        else [
            "node",
            Path("/usr/bin/node"),
            Path("/usr/local/bin/node"),
            Path("/mnt/c/Program Files/nodejs/node.exe"),
            Path("C:/Program Files/nodejs/node.exe"),
        ]
    )
)
HOST_NODE_EXECUTABLE = _first_executable(
    *(
        [
            Path("C:/Program Files/nodejs/node.exe"),
            "node",
        ]
        if os.name == "nt"
        else [
            "node",
            Path("/usr/bin/node"),
            Path("/usr/local/bin/node"),
            Path("/mnt/c/Program Files/nodejs/node.exe"),
        ]
    )
)


def _find_available_port(*preferred_ports: int) -> str:
    def runtime_can_bind(port: int) -> bool:
        backend_python = str(BACKEND_PYTHON)
        if not backend_python.lower().endswith(".exe"):
            return True

        check_script = (
            "import socket, sys; "
            "sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM); "
            "sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); "
            "sock.bind(('127.0.0.1', int(sys.argv[1]))); "
            "sock.close()"
        )
        try:
            result = subprocess.run(
                [backend_python, "-c", check_script, str(port)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except OSError:
            return False
        return result.returncode == 0

    for port in preferred_ports:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
            if not runtime_can_bind(port):
                continue
            return str(port)

    for _ in range(20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            port = int(sock.getsockname()[1])
            if runtime_can_bind(port):
                return str(port)

    raise RuntimeError("Could not find a free localhost port for Playwright webServer")


def _apply_stable_temp_env(env: dict[str, str]) -> None:
    """Keep Linux/WSL pytest capture away from inherited Windows temp paths."""
    if os.name == "nt":
        return

    stable_tmp = "/tmp"
    env["TMPDIR"] = stable_tmp
    env["TEMP"] = stable_tmp
    env["TMP"] = stable_tmp


def _prepare_playwright_fixtures(env: dict[str, str]) -> bool:
    if not REVIEW_DATASET_BUILDER.exists():
        print(f"[CI] Missing Playwright fixture builder: {REVIEW_DATASET_BUILDER}")
        return False
    result = subprocess.run([str(BACKEND_PYTHON), "scripts/build_review_dataset.py"], cwd=ROOT, env=env)
    return result.returncode == 0


def _run_ci(coverage_run_id: str) -> int:
    checks: list[tuple[str, list[str], Path]] = [
        (
            "compiled lock freshness",
            [
                str(BACKEND_PYTHON),
                "scripts/check_lockfiles.py",
            ],
            ROOT,
        ),
        (
            "dependency security audit",
            [
                str(BACKEND_PYTHON),
                "scripts/security_check.py",
            ],
            ROOT,
        ),
        (
            "frontend js syntax",
            [
                sys.executable,
                "-c",
                (
                    "import subprocess, sys; "
                    "node = sys.argv[1]; files = sys.argv[2:]; "
                    "failed = [path for path in files if subprocess.run([node, '--check', path]).returncode != 0]; "
                    "print(f'Checked {len(files)} frontend JS files'); "
                    "sys.exit(1 if failed else 0)"
                ),
                str(HOST_NODE_EXECUTABLE),
                *[str(path) for path in FRONTEND_JS_FILES],
            ],
            ROOT,
        ),
        (
            "e2e typescript typecheck",
            [
                str(NODE_EXECUTABLE),
                "./node_modules/typescript/lib/tsc.js",
                "--noEmit",
                "-p",
                "tsconfig.json",
            ],
            ROOT / "tests" / "e2e",
        ),
        (
            "ruff lint",
            [
                str(BACKEND_PYTHON),
                "-m",
                "ruff",
                "check",
                "backend",
            ],
            ROOT,
        ),
        (
            "backend full suite",
            [
                str(BACKEND_PYTHON),
                "-m",
                "pytest",
                "-p",
                "pytest_cov",
                "backend/tests",
                "-q",
                "--cov=backend",
                "--cov-report=term-missing",
                "--cov-report=xml:backend/coverage.xml",
            ],
            ROOT,
        ),
        (
            "playwright e2e",
            [
                str(NODE_EXECUTABLE),
                (
                    "./scripts/run-playwright.mjs"
                    if PLAYWRIGHT_WRAPPER.exists()
                    else ("./node_modules/playwright/cli.js" if PLAYWRIGHT_CLI.exists() else str(E2E_PLAYWRIGHT))
                ),
                "test",
            ],
            ROOT / "tests" / "e2e",
        ),
        (
            # Click-coverage ratchet (QA coverage ledger): merges the
            # click-ledger JSONL with the crawl's control inventory and fails
            # when coverage drops below tests/e2e/coverage-baseline.json.
            "click coverage gate",
            [
                str(BACKEND_PYTHON),
                "scripts/coverage_gate.py",
            ],
            ROOT,
        ),
    ]

    # Checks that are allowed to fail without blocking the CI pipeline.
    #
    # The dependency security audit is now BLOCKING: scripts/security_check.py
    # scans the full resolved dependency tree and explicitly allowlists the
    # advisories we have reviewed and accepted (IGNORED_VULN_IDS). Any NEW,
    # un-reviewed advisory will fail CI on purpose. To accept a new advisory,
    # add its id to IGNORED_VULN_IDS with a documented rationale; do not move the
    # audit back to non-blocking.
    non_blocking_checks: set[str] = set()

    all_ok = True
    passed_checks: set[str] = set()
    for name, command, cwd in checks:
        if name == "click coverage gate" and "playwright e2e" not in passed_checks:
            print(
                "[CI] SKIPPED: click coverage gate — playwright e2e did not "
                "pass in this CI invocation."
            )
            all_ok = False
            continue
        if name == "click coverage gate":
            command = [*command, "--expected-run-id", coverage_run_id]
        print(f"[CI] Working directory: {cwd}")
        env = os.environ.copy()
        _apply_stable_temp_env(env)
        if name == "playwright e2e":
            try:
                _require_sharded_full_ci(env)
            except ValueError as error:
                print(f"[CI] FAILED: {error}")
                all_ok = False
                continue
            if not _prepare_playwright_fixtures(env):
                print("[CI] FAILED: playwright fixture prep")
                all_ok = False
                continue
            env_values = {
                "PW_REUSE_SERVER": "1",
                "PW_WEB_SERVER_PORT": _find_available_port(19087, 19187, 19287),
                "PW_COVERAGE_RUN_ID": coverage_run_id,
            }
            env.update(env_values)
            if str(command[0]).lower().endswith(".exe") and os.name != "nt":
                script_path = command[1]
                cli_args = command[2:]
                env_assignments = "; ".join(
                    f"process.env[{json.dumps(key)}]={json.dumps(value)}"
                    for key, value in env_values.items()
                )
                argv = ", ".join(json.dumps(arg) for arg in cli_args)
                command = [
                    command[0],
                    "-e",
                    (
                        f"{env_assignments}; "
                        "const path = require('path'); "
                        "const { pathToFileURL } = require('url'); "
                        f"const script = {json.dumps(script_path)}; "
                        f"process.argv = [process.execPath, script, {argv}]; "
                        "(async () => { "
                        "await import(pathToFileURL(path.resolve(script)).href); "
                        "})().catch((error) => { console.error(error); process.exit(1); });"
                    ),
                ]
        result = subprocess.run(command, cwd=cwd, env=env)
        if result.returncode != 0:
            if name in non_blocking_checks:
                print(f"[CI] WARNING (non-blocking): {name}")
            else:
                print(f"[CI] FAILED: {name}")
                all_ok = False
        else:
            print(f"[CI] PASSED: {name}")
            passed_checks.add(name)

    return 0 if all_ok else 1


def main() -> int:
    coverage_run_id = _create_coverage_run_id()
    try:
        with _exclusive_ci_lock(CI_LOCK_PATH, coverage_run_id):
            return _run_ci(coverage_run_id)
    except CiLockError as error:
        print(f"[CI] FAILED: {error}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
