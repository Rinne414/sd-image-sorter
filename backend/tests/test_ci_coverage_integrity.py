from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import BinaryIO

import pytest

from scripts import run_ci, workspace_lock


def test_run_ci_direct_script_resolves_shared_workspace_lock(tmp_path: Path) -> None:
    probe = (
        "import runpy, sys; "
        "sys.path.insert(0, sys.argv[1]); "
        "runpy.run_path(sys.argv[2], run_name='ci_import_probe')"
    )
    scripts_path = run_ci.ROOT / "scripts"
    result = subprocess.run(
        [
            sys.executable,
            "-I",
            "-c",
            probe,
            str(scripts_path),
            str(scripts_path / "run_ci.py"),
        ],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr


def _install_ci_process_probe(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    playwright_returncode: int,
) -> tuple[list[tuple[str, ...]], list[str], list[dict[str, str]]]:
    executed_commands: list[tuple[str, ...]] = []
    playwright_run_ids: list[str] = []
    playwright_lock_environments: list[dict[str, str]] = []

    def select_test_port(*preferred_ports: int) -> str:
        if not preferred_ports:
            raise ValueError("The CI test port probe requires preferred ports")
        return str(preferred_ports[0])

    def run_command(
        command: list[str],
        cwd: Path,
        env: dict[str, str],
    ) -> subprocess.CompletedProcess[str]:
        if not cwd.is_absolute():
            raise ValueError(f"CI command cwd must be absolute: {cwd}")
        if not env:
            raise ValueError("CI command environment must not be empty")
        normalized = tuple(str(part) for part in command)
        executed_commands.append(normalized)
        is_playwright = any("run-playwright.mjs" in part for part in normalized)
        if is_playwright:
            run_id = env.get("PW_COVERAGE_RUN_ID")
            if not isinstance(run_id, str) or not run_id:
                raise ValueError("Playwright CI command requires PW_COVERAGE_RUN_ID")
            playwright_run_ids.append(run_id)
            playwright_lock_environments.append({
                name: env.get(name, "")
                for name in (
                    "PW_BACKEND_PYTHON",
                    "PW_WORKSPACE_LOCK_CAPABILITY",
                    "PW_WORKSPACE_LOCK_HOLDER_PID",
                    "PW_WORKSPACE_LOCK_RUN_ID",
                )
            })
        returncode = playwright_returncode if is_playwright else 0
        return subprocess.CompletedProcess(normalized, returncode)

    monkeypatch.setattr(run_ci, "CI_LOCK_PATH", tmp_path / "run-ci.lock")
    monkeypatch.setattr(run_ci, "_find_available_port", select_test_port)
    monkeypatch.setattr(run_ci.subprocess, "run", run_command)
    return executed_commands, playwright_run_ids, playwright_lock_environments


def _command_was_executed(commands: list[tuple[str, ...]], script_name: str) -> bool:
    return any(any(script_name in part for part in command) for command in commands)


def test_ci_fails_when_playwright_fails(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    commands, playwright_run_ids, _playwright_lock_environments = _install_ci_process_probe(
        monkeypatch,
        tmp_path,
        playwright_returncode=1,
    )

    assert run_ci.main() == 1

    assert _command_was_executed(commands, "run-playwright.mjs")
    assert len(playwright_run_ids) == 1
    assert "FAILED: playwright e2e" in capsys.readouterr().out


def test_ci_hands_playwright_its_run_identity_and_the_held_lock(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    commands, playwright_run_ids, playwright_lock_environments = _install_ci_process_probe(
        monkeypatch,
        tmp_path,
        playwright_returncode=0,
    )

    assert run_ci.main() == 0

    assert _command_was_executed(commands, "run-playwright.mjs")
    assert len(playwright_run_ids) == 1
    assert len(playwright_lock_environments) == 1
    lock_environment = playwright_lock_environments[0]
    assert Path(lock_environment["PW_BACKEND_PYTHON"]) == run_ci.BACKEND_PYTHON
    assert lock_environment["PW_WORKSPACE_LOCK_RUN_ID"] == playwright_run_ids[0]
    assert lock_environment["PW_WORKSPACE_LOCK_HOLDER_PID"] == str(os.getpid())
    assert len(lock_environment["PW_WORKSPACE_LOCK_CAPABILITY"]) >= 32


@pytest.mark.parametrize(
    ("environment_name", "environment_value"),
    [
        ("PW_DISABLE_SHARDING", "1"),
        ("PW_SHARD_COUNT", "1"),
        ("PW_SHARD_COUNT", "01"),
        ("PW_SHARD_COUNT", "٠٢"),
        ("BASE_URL", "http://127.0.0.1:8487"),
        ("SD_IMAGE_SORTER_PORT", "8487"),
    ],
)
def test_ci_rejects_non_sharded_full_run_configuration_before_playwright(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    environment_name: str,
    environment_value: str,
) -> None:
    monkeypatch.setenv(environment_name, environment_value)
    commands, playwright_run_ids, _playwright_lock_environments = _install_ci_process_probe(
        monkeypatch,
        tmp_path,
        playwright_returncode=0,
    )

    assert run_ci.main() == 1

    assert not _command_was_executed(commands, "run-playwright.mjs")
    assert playwright_run_ids == []
    assert "full CI requires the sharded Playwright run" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("repo_root", "node_executable", "host_os_name", "environment", "message"),
    [
        (
            Path("/mnt/l/sd-image-sorter"),
            "/usr/bin/node",
            "posix",
            {"WSL_DISTRO_NAME": "Ubuntu"},
            "WSL on a Windows-mounted workspace",
        ),
        (
            Path("/home/user/sd-image-sorter"),
            "/mnt/c/Program Files/nodejs/node.exe",
            "posix",
            {"WSL_DISTRO_NAME": "Ubuntu"},
            "mix a POSIX workspace lock with Windows node.exe",
        ),
        (
            Path(r"\\wsl.localhost\Ubuntu\home\user\sd-image-sorter"),
            r"C:\Program Files\nodejs\node.exe",
            "nt",
            {},
            "Windows on a WSL filesystem workspace",
        ),
    ],
)
def test_ci_rejects_cross_os_workspace_lock_boundaries(
    repo_root: Path,
    node_executable: str,
    host_os_name: str,
    environment: dict[str, str],
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        run_ci._require_workspace_lock_runtime_compatibility(
            repo_root,
            node_executable,
            host_os_name,
            environment,
        )

    run_ci._require_workspace_lock_runtime_compatibility(
        Path("/home/user/sd-image-sorter"),
        "/usr/bin/node",
        "posix",
        {"WSL_DISTRO_NAME": "Ubuntu"},
    )
    run_ci._require_workspace_lock_runtime_compatibility(
        Path(r"L:\sd-image-sorter"),
        r"C:\Program Files\nodejs\node.exe",
        "nt",
        {},
    )


def test_ci_lock_rejects_a_real_overlapping_process(tmp_path: Path) -> None:
    lock_path = tmp_path / "run-ci.lock"
    holder_script = """
import sys
from pathlib import Path
from scripts.run_ci import _exclusive_ci_lock

with _exclusive_ci_lock(Path(sys.argv[1]), "holder-run", "holder-capability-value-00000000"):
    print("LOCKED", flush=True)
    sys.stdin.readline()
"""
    holder = subprocess.Popen(
        [sys.executable, "-c", holder_script, str(lock_path)],
        cwd=run_ci.ROOT,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if holder.stdout is None or holder.stdin is None:
        holder.kill()
        raise RuntimeError("Lock holder pipes were not created")
    ready = holder.stdout.readline().strip()
    if ready != "LOCKED":
        holder.wait(timeout=10)
        stderr = holder.stderr.read() if holder.stderr else ""
        pytest.fail(f"Lock holder did not start: ready={ready!r}, stderr={stderr!r}")
    try:
        with pytest.raises(run_ci.CiLockError, match="another CI or Playwright") as error_info:
            with run_ci._exclusive_ci_lock(
                lock_path,
                "contender-run",
                "contender-capability-value-00000000",
            ):
                raise AssertionError("Overlapping CI lock unexpectedly succeeded")
        assert "holder-run" in str(error_info.value)
    finally:
        if holder.poll() is None:
            holder.stdin.write("release\n")
            holder.stdin.flush()
            holder.wait(timeout=10)
    assert holder.returncode == 0, holder.stderr.read() if holder.stderr else ""
    with run_ci._exclusive_ci_lock(
        lock_path,
        "successor-run",
        "successor-capability-value-00000000",
    ):
        pass
    owner_header = lock_path.read_bytes()[: run_ci.CI_LOCK_BYTE_OFFSET].rstrip(b"\0")
    owner = json.loads(owner_header.decode("utf-8"))
    assert owner["runId"] == "successor-run"


def test_ci_lock_closes_descriptor_without_masking_an_inflight_error(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    lock_path = tmp_path / "run-ci.lock"
    opened_handles: list[BinaryIO] = []
    real_fdopen = workspace_lock.os.fdopen
    real_unlock_file = workspace_lock._unlock_file

    def capture_handle(file_descriptor: int, mode: str, buffering: int) -> BinaryIO:
        handle = real_fdopen(file_descriptor, mode, buffering)
        opened_handles.append(handle)
        return handle

    def fail_unlock(_handle: BinaryIO) -> None:
        raise OSError("synthetic unlock failure")

    monkeypatch.setattr(workspace_lock.os, "fdopen", capture_handle)
    monkeypatch.setattr(workspace_lock, "_unlock_file", fail_unlock)
    body_error = RuntimeError("synthetic CI body failure")
    caught_error: RuntimeError | None = None
    handle_was_closed = False
    try:
        try:
            with run_ci._exclusive_ci_lock(
                lock_path,
                "failing-run",
                "failing-capability-value-000000000",
            ):
                raise body_error
        except RuntimeError as error:
            caught_error = error
        if not opened_handles:
            raise AssertionError("CI lock did not open its lock file")
        handle_was_closed = opened_handles[-1].closed
    finally:
        for handle in opened_handles:
            if not handle.closed:
                handle.close()
        monkeypatch.setattr(workspace_lock, "_unlock_file", real_unlock_file)

    assert caught_error is body_error
    assert handle_was_closed
    assert any(
        "failed to release full CI workspace lock" in note
        for note in getattr(body_error, "__notes__", [])
    )
    with run_ci._exclusive_ci_lock(
        lock_path,
        "successor-run",
        "successor-capability-value-00000000",
    ):
        pass


def test_ci_lock_reports_unlock_failure_after_a_successful_body(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    lock_path = tmp_path / "run-ci.lock"
    real_unlock_file = workspace_lock._unlock_file

    def fail_unlock(_handle: BinaryIO) -> None:
        raise OSError("synthetic unlock failure")

    monkeypatch.setattr(workspace_lock, "_unlock_file", fail_unlock)
    with pytest.raises(run_ci.CiLockError, match="failed to release full CI workspace lock"):
        with run_ci._exclusive_ci_lock(
            lock_path,
            "failing-run",
            "failing-capability-value-000000000",
        ):
            pass

    monkeypatch.setattr(workspace_lock, "_unlock_file", real_unlock_file)
    with run_ci._exclusive_ci_lock(
        lock_path,
        "successor-run",
        "successor-capability-value-00000000",
    ):
        pass


def test_inherited_workspace_lock_requires_a_live_matching_owner(tmp_path: Path) -> None:
    lock_path = tmp_path / "run-ci.lock"
    capability = "matching-inherited-capability-value"
    owner = workspace_lock.create_lock_owner(
        workspace_lock.CANONICAL_WORKSPACE_LOCK_SCOPE,
        os.getpid(),
        "fixture-run",
        capability,
    )

    with workspace_lock.exclusive_workspace_lock(lock_path, owner, "fixture workspace"):
        verified = workspace_lock.verify_inherited_workspace_lock(
            lock_path,
            workspace_lock.CANONICAL_WORKSPACE_LOCK_SCOPE,
            os.getpid(),
            "fixture-run",
            capability,
        )
        assert verified == owner
        with pytest.raises(workspace_lock.WorkspaceLockError) as error_info:
            workspace_lock.verify_inherited_workspace_lock(
                lock_path,
                workspace_lock.CANONICAL_WORKSPACE_LOCK_SCOPE,
                os.getpid(),
                "fixture-run",
                "wrong-inherited-capability-value-00",
            )
        assert "capabilitySha256" in str(error_info.value)
        assert capability not in str(error_info.value)

    with pytest.raises(workspace_lock.WorkspaceLockError, match="not currently held"):
        workspace_lock.verify_inherited_workspace_lock(
            lock_path,
            workspace_lock.CANONICAL_WORKSPACE_LOCK_SCOPE,
            os.getpid(),
            "fixture-run",
            capability,
        )
