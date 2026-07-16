from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import BinaryIO

import pytest

from scripts import coverage_gate, run_ci


def _install_ci_process_probe(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    playwright_returncode: int,
) -> tuple[list[tuple[str, ...]], list[str]]:
    executed_commands: list[tuple[str, ...]] = []
    playwright_run_ids: list[str] = []

    def fixtures_are_ready(env: dict[str, str]) -> bool:
        if not env:
            raise ValueError("CI fixture environment must not be empty")
        return True

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
        returncode = playwright_returncode if is_playwright else 0
        return subprocess.CompletedProcess(normalized, returncode)

    monkeypatch.setattr(run_ci, "CI_LOCK_PATH", tmp_path / "run-ci.lock")
    monkeypatch.setattr(run_ci, "_prepare_playwright_fixtures", fixtures_are_ready)
    monkeypatch.setattr(run_ci, "_find_available_port", select_test_port)
    monkeypatch.setattr(run_ci.subprocess, "run", run_command)
    return executed_commands, playwright_run_ids


def _command_was_executed(commands: list[tuple[str, ...]], script_name: str) -> bool:
    return any(any(script_name in part for part in command) for command in commands)


def _configure_coverage_gate_fixture(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    artifacts = tmp_path / "artifacts"
    ledger = artifacts / "click-coverage"
    inventory = artifacts / "control-inventory.json"
    baseline = tmp_path / "coverage-baseline.json"
    ledger.mkdir(parents=True)
    inventory.write_text(
        json.dumps({"controls": [{"key": "gallery|button", "context": "gallery"}]}),
        encoding="utf-8",
    )
    (ledger / "raw-worker-0.jsonl").write_text(
        json.dumps({"key": "gallery|button", "test": "fixture"}) + "\n",
        encoding="utf-8",
    )
    baseline.write_text(
        json.dumps({"min_click_coverage_pct": 100.0, "waivers": []}),
        encoding="utf-8",
    )
    monkeypatch.setattr(coverage_gate, "ARTIFACTS", artifacts)
    monkeypatch.setattr(coverage_gate, "INVENTORY_PATH", inventory)
    monkeypatch.setattr(coverage_gate, "LEDGER_DIR", ledger)
    monkeypatch.setattr(
        coverage_gate,
        "COVERAGE_RUN_PATH",
        artifacts / "click-coverage-run.json",
    )
    monkeypatch.setattr(
        coverage_gate,
        "PLAYWRIGHT_LAST_RUN_PATH",
        tmp_path / "test-results" / ".last-run.json",
    )
    monkeypatch.setattr(coverage_gate, "MERGED_PATH", artifacts / "click-coverage.json")
    monkeypatch.setattr(coverage_gate, "UNTESTED_PATH", artifacts / "untested-controls.json")
    monkeypatch.setattr(coverage_gate, "BASELINE_PATH", baseline)
    monkeypatch.setattr(
        sys,
        "argv",
        ["coverage_gate.py", "--expected-run-id", "fixture-run"],
    )


def test_ci_skips_click_coverage_gate_after_playwright_failure(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    commands, playwright_run_ids = _install_ci_process_probe(
        monkeypatch,
        tmp_path,
        playwright_returncode=1,
    )

    assert run_ci.main() == 1

    assert _command_was_executed(commands, "run-playwright.mjs")
    assert len(playwright_run_ids) == 1
    assert not _command_was_executed(commands, "coverage_gate.py")
    assert "SKIPPED: click coverage gate" in capsys.readouterr().out


def test_ci_runs_click_coverage_gate_after_playwright_success(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    commands, playwright_run_ids = _install_ci_process_probe(
        monkeypatch,
        tmp_path,
        playwright_returncode=0,
    )

    assert run_ci.main() == 0

    playwright_index = next(
        index
        for index, command in enumerate(commands)
        if any("run-playwright.mjs" in part for part in command)
    )
    coverage_index = next(
        index
        for index, command in enumerate(commands)
        if any("coverage_gate.py" in part for part in command)
    )
    assert playwright_index < coverage_index
    coverage_command = commands[coverage_index]
    expected_id_index = coverage_command.index("--expected-run-id") + 1
    assert playwright_run_ids == [coverage_command[expected_id_index]]


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
    commands, playwright_run_ids = _install_ci_process_probe(
        monkeypatch,
        tmp_path,
        playwright_returncode=0,
    )

    assert run_ci.main() == 1

    assert not _command_was_executed(commands, "run-playwright.mjs")
    assert not _command_was_executed(commands, "coverage_gate.py")
    assert playwright_run_ids == []
    assert "full CI click coverage requires sharded Playwright" in capsys.readouterr().out


def test_ci_lock_rejects_a_real_overlapping_process(tmp_path: Path) -> None:
    lock_path = tmp_path / "run-ci.lock"
    holder_script = """
import sys
from pathlib import Path
from scripts.run_ci import _exclusive_ci_lock

with _exclusive_ci_lock(Path(sys.argv[1]), "holder-run"):
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
        with pytest.raises(run_ci.CiLockError, match="another full CI invocation") as error_info:
            with run_ci._exclusive_ci_lock(lock_path, "contender-run"):
                raise AssertionError("Overlapping CI lock unexpectedly succeeded")
        assert "holder-run" in str(error_info.value)
    finally:
        if holder.poll() is None:
            holder.stdin.write("release\n")
            holder.stdin.flush()
            holder.wait(timeout=10)
    assert holder.returncode == 0, holder.stderr.read() if holder.stderr else ""
    with run_ci._exclusive_ci_lock(lock_path, "successor-run"):
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
    real_fdopen = run_ci.os.fdopen
    real_unlock_file = run_ci._unlock_file

    def capture_handle(file_descriptor: int, mode: str, buffering: int) -> BinaryIO:
        handle = real_fdopen(file_descriptor, mode, buffering)
        opened_handles.append(handle)
        return handle

    def fail_unlock(_handle: BinaryIO) -> None:
        raise OSError("synthetic unlock failure")

    monkeypatch.setattr(run_ci.os, "fdopen", capture_handle)
    monkeypatch.setattr(run_ci, "_unlock_file", fail_unlock)
    body_error = RuntimeError("synthetic CI body failure")
    caught_error: RuntimeError | None = None
    handle_was_closed = False
    try:
        try:
            with run_ci._exclusive_ci_lock(lock_path, "failing-run"):
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
        monkeypatch.setattr(run_ci, "_unlock_file", real_unlock_file)

    assert caught_error is body_error
    assert handle_was_closed
    assert any(
        "failed to release full CI workspace lock" in note
        for note in getattr(body_error, "__notes__", [])
    )
    with run_ci._exclusive_ci_lock(lock_path, "successor-run"):
        pass


def test_ci_lock_reports_unlock_failure_after_a_successful_body(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    lock_path = tmp_path / "run-ci.lock"
    real_unlock_file = run_ci._unlock_file

    def fail_unlock(_handle: BinaryIO) -> None:
        raise OSError("synthetic unlock failure")

    monkeypatch.setattr(run_ci, "_unlock_file", fail_unlock)
    with pytest.raises(run_ci.CiLockError, match="failed to release full CI workspace lock"):
        with run_ci._exclusive_ci_lock(lock_path, "failing-run"):
            pass

    monkeypatch.setattr(run_ci, "_unlock_file", real_unlock_file)
    with run_ci._exclusive_ci_lock(lock_path, "successor-run"):
        pass


def test_coverage_gate_rejects_mismatched_run_identity_before_writing_outputs(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _configure_coverage_gate_fixture(monkeypatch, tmp_path)
    coverage_gate.COVERAGE_RUN_PATH.write_text(
        json.dumps({"schemaVersion": 1, "runId": "coverage-run"}),
        encoding="utf-8",
    )
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.parent.mkdir(parents=True)
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.write_text(
        json.dumps({"status": "passed", "failedTests": [], "runId": "terminal-run"}),
        encoding="utf-8",
    )
    coverage_gate.MERGED_PATH.write_text("stale", encoding="utf-8")
    coverage_gate.UNTESTED_PATH.write_text("stale", encoding="utf-8")

    assert coverage_gate.main() == 1

    output = capsys.readouterr().out
    assert "run identity mismatch" in output
    assert "coverage-run" in output
    assert "terminal-run" in output
    assert not coverage_gate.MERGED_PATH.exists()
    assert not coverage_gate.UNTESTED_PATH.exists()


def test_coverage_gate_accepts_matching_successful_run_identity(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _configure_coverage_gate_fixture(monkeypatch, tmp_path)
    coverage_gate.COVERAGE_RUN_PATH.write_text(
        json.dumps({"schemaVersion": 1, "runId": "fixture-run"}),
        encoding="utf-8",
    )
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.parent.mkdir(parents=True)
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.write_text(
        json.dumps({"status": "passed", "failedTests": [], "runId": "fixture-run"}),
        encoding="utf-8",
    )

    assert coverage_gate.main() == 0

    assert coverage_gate.MERGED_PATH.exists()
    assert coverage_gate.UNTESTED_PATH.exists()


def test_coverage_gate_rejects_identity_replaced_while_reading_ledger(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _configure_coverage_gate_fixture(monkeypatch, tmp_path)
    coverage_gate.COVERAGE_RUN_PATH.write_text(
        json.dumps({"schemaVersion": 1, "runId": "fixture-run"}),
        encoding="utf-8",
    )
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.parent.mkdir(parents=True)
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.write_text(
        json.dumps({"status": "passed", "failedTests": [], "runId": "fixture-run"}),
        encoding="utf-8",
    )
    load_clicked_keys = coverage_gate._load_clicked_keys

    def replace_identity_after_ledger_read() -> tuple[set[str], dict[str, int]]:
        result = load_clicked_keys()
        coverage_gate.COVERAGE_RUN_PATH.write_text(
            json.dumps({"schemaVersion": 1, "runId": "other-run"}),
            encoding="utf-8",
        )
        coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.write_text(
            json.dumps({"status": "passed", "failedTests": [], "runId": "other-run"}),
            encoding="utf-8",
        )
        return result

    monkeypatch.setattr(coverage_gate, "_load_clicked_keys", replace_identity_after_ledger_read)

    assert coverage_gate.main() == 1

    assert "coverage inputs changed while reading" in capsys.readouterr().out
    assert not coverage_gate.MERGED_PATH.exists()
    assert not coverage_gate.UNTESTED_PATH.exists()


def test_coverage_gate_removes_outputs_when_identity_changes_during_write(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _configure_coverage_gate_fixture(monkeypatch, tmp_path)
    coverage_gate.COVERAGE_RUN_PATH.write_text(
        json.dumps({"schemaVersion": 1, "runId": "fixture-run"}),
        encoding="utf-8",
    )
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.parent.mkdir(parents=True)
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.write_text(
        json.dumps({"status": "passed", "failedTests": [], "runId": "fixture-run"}),
        encoding="utf-8",
    )
    load_current_run_id = coverage_gate._load_current_run_id
    identity_checks = 0

    def replace_identity_after_prewrite_check(expected_run_id: str) -> str:
        nonlocal identity_checks
        run_id = load_current_run_id(expected_run_id)
        identity_checks += 1
        if identity_checks == 2:
            coverage_gate.COVERAGE_RUN_PATH.write_text(
                json.dumps({"schemaVersion": 1, "runId": "other-run"}),
                encoding="utf-8",
            )
            coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.write_text(
                json.dumps({"status": "passed", "failedTests": [], "runId": "other-run"}),
                encoding="utf-8",
            )
        return run_id

    monkeypatch.setattr(
        coverage_gate,
        "_load_current_run_id",
        replace_identity_after_prewrite_check,
    )

    assert coverage_gate.main() == 1

    assert "coverage inputs changed while writing" in capsys.readouterr().out
    assert not coverage_gate.MERGED_PATH.exists()
    assert not coverage_gate.UNTESTED_PATH.exists()


def test_coverage_gate_rejects_matching_canonical_identity_from_another_invocation(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _configure_coverage_gate_fixture(monkeypatch, tmp_path)
    coverage_gate.COVERAGE_RUN_PATH.write_text(
        json.dumps({"schemaVersion": 1, "runId": "other-run"}),
        encoding="utf-8",
    )
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.parent.mkdir(parents=True)
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.write_text(
        json.dumps({"status": "passed", "failedTests": [], "runId": "other-run"}),
        encoding="utf-8",
    )

    assert coverage_gate.main() == 1

    output = capsys.readouterr().out
    assert "expected runId='fixture-run'" in output
    assert "current runId='other-run'" in output
    assert not coverage_gate.MERGED_PATH.exists()
    assert not coverage_gate.UNTESTED_PATH.exists()


def test_coverage_gate_rejects_failed_terminal_status(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _configure_coverage_gate_fixture(monkeypatch, tmp_path)
    coverage_gate.COVERAGE_RUN_PATH.write_text(
        json.dumps({"schemaVersion": 1, "runId": "fixture-run"}),
        encoding="utf-8",
    )
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.parent.mkdir(parents=True)
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.write_text(
        json.dumps(
            {
                "status": "failed",
                "failedTests": ["fixture failure"],
                "runId": "fixture-run",
            }
        ),
        encoding="utf-8",
    )

    assert coverage_gate.main() == 1

    assert "not a clean success" in capsys.readouterr().out
    assert not coverage_gate.MERGED_PATH.exists()
    assert not coverage_gate.UNTESTED_PATH.exists()


def test_coverage_gate_rejects_unsupported_identity_schema(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _configure_coverage_gate_fixture(monkeypatch, tmp_path)
    coverage_gate.COVERAGE_RUN_PATH.write_text(
        json.dumps({"schemaVersion": 2, "runId": "fixture-run"}),
        encoding="utf-8",
    )
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.parent.mkdir(parents=True)
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.write_text(
        json.dumps({"status": "passed", "failedTests": [], "runId": "fixture-run"}),
        encoding="utf-8",
    )

    assert coverage_gate.main() == 1

    assert "requires schemaVersion=1" in capsys.readouterr().out
    assert not coverage_gate.MERGED_PATH.exists()
    assert not coverage_gate.UNTESTED_PATH.exists()


def test_coverage_gate_reports_invalid_identity_utf8_without_traceback(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _configure_coverage_gate_fixture(monkeypatch, tmp_path)
    coverage_gate.COVERAGE_RUN_PATH.write_bytes(b"\xff\xfe")
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.parent.mkdir(parents=True)
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.write_text(
        json.dumps({"status": "passed", "failedTests": [], "runId": "fixture-run"}),
        encoding="utf-8",
    )

    assert coverage_gate.main() == 1

    output = capsys.readouterr().out
    assert "invalid UTF-8" in output
    assert str(coverage_gate.COVERAGE_RUN_PATH) in output
    assert "Traceback" not in output


@pytest.mark.parametrize(
    ("artifact_name", "payload", "expected_error"),
    [
        ("inventory", "{", "control inventory is invalid JSON"),
        (
            "inventory",
            '{"controls":[{}]}',
            "control inventory row 0 requires non-empty string field 'key'",
        ),
        (
            "inventory",
            '{"controls":[{"key":"gallery|button"}]}',
            "control inventory row 0 requires non-empty string field 'context'",
        ),
        ("ledger", "{", "click ledger row is invalid JSON"),
        (
            "ledger",
            "{}",
            "click ledger row 1 requires non-empty string field 'key'",
        ),
        ("baseline", "{", "coverage baseline is invalid JSON"),
        (
            "baseline",
            '{"waivers":[]}',
            "coverage baseline requires numeric field 'min_click_coverage_pct'",
        ),
        (
            "baseline",
            '{"min_click_coverage_pct":39.0}',
            "coverage baseline requires 'waivers'",
        ),
        (
            "baseline",
            '{"min_click_coverage_pct":NaN,"waivers":[]}',
            "coverage baseline field 'min_click_coverage_pct' must be finite",
        ),
    ],
)
def test_coverage_gate_reports_malformed_coverage_inputs_without_traceback(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    artifact_name: str,
    payload: str,
    expected_error: str,
) -> None:
    _configure_coverage_gate_fixture(monkeypatch, tmp_path)
    coverage_gate.COVERAGE_RUN_PATH.write_text(
        json.dumps({"schemaVersion": 1, "runId": "fixture-run"}),
        encoding="utf-8",
    )
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.parent.mkdir(parents=True)
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.write_text(
        json.dumps({"status": "passed", "failedTests": [], "runId": "fixture-run"}),
        encoding="utf-8",
    )
    artifact_paths = {
        "baseline": coverage_gate.BASELINE_PATH,
        "inventory": coverage_gate.INVENTORY_PATH,
        "ledger": next(coverage_gate.LEDGER_DIR.glob("raw-*.jsonl")),
    }
    artifact_paths[artifact_name].write_text(payload, encoding="utf-8")

    assert coverage_gate.main() == 1

    output = capsys.readouterr().out
    assert expected_error in output
    assert "Traceback" not in output
    assert not coverage_gate.MERGED_PATH.exists()
    assert not coverage_gate.UNTESTED_PATH.exists()


def test_coverage_gate_requires_the_committed_coverage_baseline(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _configure_coverage_gate_fixture(monkeypatch, tmp_path)
    coverage_gate.COVERAGE_RUN_PATH.write_text(
        json.dumps({"schemaVersion": 1, "runId": "fixture-run"}),
        encoding="utf-8",
    )
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.parent.mkdir(parents=True)
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.write_text(
        json.dumps({"status": "passed", "failedTests": [], "runId": "fixture-run"}),
        encoding="utf-8",
    )
    coverage_gate.BASELINE_PATH.unlink()

    assert coverage_gate.main() == 1

    output = capsys.readouterr().out
    assert "missing current-run artifacts" in output
    assert str(coverage_gate.BASELINE_PATH) in output
    assert not coverage_gate.MERGED_PATH.exists()
    assert not coverage_gate.UNTESTED_PATH.exists()


def test_coverage_gate_removes_partial_outputs_when_a_write_fails(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _configure_coverage_gate_fixture(monkeypatch, tmp_path)
    coverage_gate.COVERAGE_RUN_PATH.write_text(
        json.dumps({"schemaVersion": 1, "runId": "fixture-run"}),
        encoding="utf-8",
    )
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.parent.mkdir(parents=True)
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.write_text(
        json.dumps({"status": "passed", "failedTests": [], "runId": "fixture-run"}),
        encoding="utf-8",
    )
    real_write_text = Path.write_text

    def fail_untested_write(
        path: Path,
        data: str,
        **options: str | None,
    ) -> int:
        if path == coverage_gate.UNTESTED_PATH:
            raise OSError("synthetic output write failure")
        return real_write_text(path, data, **options)

    monkeypatch.setattr(Path, "write_text", fail_untested_write)

    assert coverage_gate.main() == 1

    output = capsys.readouterr().out
    assert "could not write coverage outputs" in output
    assert "synthetic output write failure" in output
    assert "Traceback" not in output
    assert not coverage_gate.MERGED_PATH.exists()
    assert not coverage_gate.UNTESTED_PATH.exists()


def test_coverage_gate_requires_current_run_identity(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _configure_coverage_gate_fixture(monkeypatch, tmp_path)

    assert coverage_gate.main() == 1

    output = capsys.readouterr().out
    assert "missing current-run artifacts" in output
    assert "click-coverage-run.json" in output
    assert ".last-run.json" in output
    assert not coverage_gate.MERGED_PATH.exists()
    assert not coverage_gate.UNTESTED_PATH.exists()


@pytest.mark.parametrize(
    ("coverage_marker", "terminal_status", "expected_error"),
    [
        (
            "{",
            '{"status":"passed","failedTests":[],"runId":"fixture-run"}',
            "coverage run marker is invalid JSON",
        ),
        (
            "[]",
            '{"status":"passed","failedTests":[],"runId":"fixture-run"}',
            "coverage run marker must be a JSON object",
        ),
        (
            '{"schemaVersion":1,"runId":"fixture-run"}',
            "{",
            "Playwright terminal status is invalid JSON",
        ),
        (
            '{"schemaVersion":1,"runId":"fixture-run"}',
            "[]",
            "Playwright terminal status must be a JSON object",
        ),
    ],
)
def test_coverage_gate_rejects_malformed_identity_artifacts(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    coverage_marker: str,
    terminal_status: str,
    expected_error: str,
) -> None:
    _configure_coverage_gate_fixture(monkeypatch, tmp_path)
    coverage_gate.COVERAGE_RUN_PATH.write_text(coverage_marker, encoding="utf-8")
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.parent.mkdir(parents=True)
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.write_text(
        terminal_status,
        encoding="utf-8",
    )
    coverage_gate.MERGED_PATH.write_text("stale", encoding="utf-8")
    coverage_gate.UNTESTED_PATH.write_text("stale", encoding="utf-8")

    assert coverage_gate.main() == 1

    assert expected_error in capsys.readouterr().out
    assert not coverage_gate.MERGED_PATH.exists()
    assert not coverage_gate.UNTESTED_PATH.exists()


def test_coverage_gate_rejects_native_run_status_without_run_identity(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _configure_coverage_gate_fixture(monkeypatch, tmp_path)
    coverage_gate.COVERAGE_RUN_PATH.write_text(
        json.dumps({"schemaVersion": 1, "runId": "fixture-run"}),
        encoding="utf-8",
    )
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.parent.mkdir(parents=True)
    coverage_gate.PLAYWRIGHT_LAST_RUN_PATH.write_text(
        json.dumps({"status": "passed", "failedTests": []}),
        encoding="utf-8",
    )

    assert coverage_gate.main() == 1

    output = capsys.readouterr().out
    assert "Playwright terminal status requires non-empty string field 'runId'" in output
    assert not coverage_gate.MERGED_PATH.exists()
    assert not coverage_gate.UNTESTED_PATH.exists()
