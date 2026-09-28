#!/usr/bin/env python3
"""Minimal CI entrypoint for sd-image-sorter release work."""

from __future__ import annotations

import argparse
import subprocess
import sys
import os
import re
import secrets
import shutil
import socket
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Sequence

if __package__:
    from . import workspace_lock
else:
    import workspace_lock

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
CI_LOCK_PATH = ROOT / ".tmp" / "run-ci.lock"
CI_LOCK_BYTE_OFFSET = workspace_lock.LOCK_BYTE_OFFSET
CI_SHARD_COUNT_PATTERN = re.compile(r"^[0-9]+$")
CI_MIN_SHARD_COUNT = 2
CI_MAX_SHARD_COUNT = 8
# Backend test processes: half the logical CPUs, at most 4. Each worker loads
# the AI libraries; 8 of them next to a busy browser ran a 32 GB PC out of
# memory (2026-09-28). --backend-workers raises it or sets 1 process.
DEFAULT_BACKEND_WORKERS = max(1, min(4, (os.cpu_count() or 2) // 2))


CiLockError = workspace_lock.WorkspaceLockError


@contextmanager
def _exclusive_ci_lock(
    lock_path: Path,
    run_id: str,
    capability: str,
) -> Iterator[workspace_lock.WorkspaceLockOwner]:
    owner = workspace_lock.create_lock_owner(
        workspace_lock.CANONICAL_WORKSPACE_LOCK_SCOPE,
        os.getpid(),
        run_id,
        capability,
    )
    try:
        with workspace_lock.exclusive_workspace_lock(
            lock_path,
            owner,
            "full CI workspace",
        ) as locked_owner:
            yield locked_owner
    except workspace_lock.WorkspaceLockBusyError as error:
        raise CiLockError(
            "another CI or Playwright test command owns the canonical workspace lock; "
            f"wait for it to finish. {error}"
        ) from error


def _create_coverage_run_id() -> str:
    return f"ci-{uuid.uuid4().hex}"


def _create_lock_capability() -> str:
    return secrets.token_hex(32)


def _require_workspace_lock_runtime_compatibility(
    repo_root: Path,
    node_executable: str,
    host_os_name: str,
    environment: dict[str, str],
) -> None:
    if host_os_name not in {"nt", "posix"}:
        raise ValueError(f"unsupported CI host OS family: {host_os_name}")
    normalized_root = str(repo_root).replace("\\", "/")
    node_is_windows = node_executable.lower().endswith(".exe")
    is_wsl = bool(environment.get("WSL_DISTRO_NAME") or environment.get("WSL_INTEROP"))
    if host_os_name == "posix" and is_wsl and re.match(r"^/mnt/[A-Za-z]/", normalized_root):
        raise ValueError(
            "CI/Playwright cannot provide one coherent OS lock from WSL on a Windows-mounted "
            f"workspace ({repo_root}). Run scripts/run_ci.py from Windows, or move the repository "
            "to the WSL filesystem and use WSL-native Python and Node."
        )
    if host_os_name == "posix" and node_is_windows:
        raise ValueError(
            "CI/Playwright cannot mix a POSIX workspace lock with Windows node.exe. "
            "Install a native Node.js runtime in this environment or run CI from Windows."
        )
    if host_os_name == "nt" and re.match(
        r"^//(?:wsl\$|wsl\.localhost)/",
        normalized_root,
        flags=re.IGNORECASE,
    ):
        raise ValueError(
            "CI/Playwright cannot provide one coherent OS lock from Windows on a WSL filesystem "
            f"workspace ({repo_root}). Run CI inside that WSL distribution with native Python and Node."
        )


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


def _backend_suite_command(workers: int, with_coverage: bool) -> list[str]:
    """The backend pytest run: whole test files spread over `workers` processes.

    Line coverage is measured only when asked (nothing gates on it, and it slows
    every test); the release gate asks for it with --backend-coverage.
    """
    command = [str(BACKEND_PYTHON), "-m", "pytest", "backend/tests", "-q"]
    if workers > 1:
        # Named plugins: GitHub CI sets PYTEST_DISABLE_PLUGIN_AUTOLOAD=1.
        command += ["-p", "xdist", "-n", str(workers), "--dist", "loadfile"]
    if with_coverage:
        command += [
            "-p",
            "pytest_cov",
            "--cov=backend",
            "--cov-report=term-missing",
            "--cov-report=xml:backend/coverage.xml",
        ]
    return command


def _run_ci(
    coverage_run_id: str,
    lock_capability: str,
    lock_holder_pid: int,
    *,
    backend_workers: int = DEFAULT_BACKEND_WORKERS,
    backend_coverage: bool = False,
) -> int:
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
            "runtime dependency consistency",
            [
                str(BACKEND_PYTHON),
                "scripts/check_runtime_dependencies.py",
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
            _backend_suite_command(backend_workers, backend_coverage),
            ROOT,
        ),
        (
            "v4 frontend typecheck",
            [
                str(NODE_EXECUTABLE),
                "./node_modules/typescript/lib/tsc.js",
                "--noEmit",
                "-p",
                "tsconfig.json",
            ],
            ROOT / "frontend-v4",
        ),
        (
            "v4 frontend unit tests",
            [
                str(NODE_EXECUTABLE),
                "./node_modules/vitest/vitest.mjs",
                "run",
            ],
            ROOT / "frontend-v4",
        ),
        (
            # The V4 E2E specs load /v4/ from this build (frontend-v4/dist).
            "v4 frontend build",
            [
                str(NODE_EXECUTABLE),
                "./node_modules/vite/bin/vite.js",
                "build",
            ],
            ROOT / "frontend-v4",
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
            # Click-coverage ratchet (docs/COVERAGE_LEDGER.md): the click
            # ledger records every V4 control the specs showed and every one
            # they used; the gate fails when the used share drops below
            # tests/e2e/coverage-baseline.json.
            "click coverage gate",
            [
                str(BACKEND_PYTHON),
                "scripts/coverage_gate.py",
            ],
            ROOT,
        ),
    ]

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
            env_values = {
                "PW_REUSE_SERVER": "1",
                "PW_WEB_SERVER_PORT": _find_available_port(19087, 19187, 19287),
                "PW_COVERAGE_RUN_ID": coverage_run_id,
                "PW_BACKEND_PYTHON": str(BACKEND_PYTHON),
                workspace_lock.CAPABILITY_ENV_NAME: lock_capability,
                workspace_lock.HOLDER_PID_ENV_NAME: str(lock_holder_pid),
                workspace_lock.RUN_ID_ENV_NAME: coverage_run_id,
            }
            env.update(env_values)
        result = subprocess.run(command, cwd=cwd, env=env)
        if result.returncode != 0:
            print(f"[CI] FAILED: {name}")
            all_ok = False
        else:
            print(f"[CI] PASSED: {name}")
            passed_checks.add(name)

    return 0 if all_ok else 1


def _worker_count(value: str) -> int:
    count = int(value)
    if count < 1:
        raise argparse.ArgumentTypeError("needs at least 1 worker")
    return count


def _parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--backend-coverage",
        action="store_true",
        help="also measure backend line coverage (slower; for the release gate)",
    )
    parser.add_argument(
        "--backend-workers",
        type=_worker_count,
        default=DEFAULT_BACKEND_WORKERS,
        help=f"backend test processes (default {DEFAULT_BACKEND_WORKERS}; 1 = one process)",
    )
    return parser.parse_args(list(argv))


def main(argv: Sequence[str] = ()) -> int:
    args = _parse_args(argv)
    coverage_run_id = _create_coverage_run_id()
    lock_capability = _create_lock_capability()
    lock_holder_pid = os.getpid()
    try:
        _require_workspace_lock_runtime_compatibility(
            ROOT,
            str(NODE_EXECUTABLE),
            os.name,
            os.environ.copy(),
        )
        with _exclusive_ci_lock(CI_LOCK_PATH, coverage_run_id, lock_capability):
            return _run_ci(
                coverage_run_id,
                lock_capability,
                lock_holder_pid,
                backend_workers=args.backend_workers,
                backend_coverage=args.backend_coverage,
            )
    except (CiLockError, ValueError) as error:
        print(f"[CI] FAILED: {error}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
