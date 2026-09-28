"""How the full CI runs the backend suite: in parallel, line coverage only on request."""

from __future__ import annotations

from contextlib import nullcontext

import pytest

from scripts import run_ci


def test_backend_suite_runs_in_parallel_by_file_without_coverage() -> None:
    command = run_ci._backend_suite_command(workers=8, with_coverage=False)

    assert command[:3] == [str(run_ci.BACKEND_PYTHON), "-m", "pytest"]
    assert "backend/tests" in command
    index = command.index("-n")
    assert command[index + 1] == "8"
    # named, because GitHub CI turns plugin autoloading off
    assert command[command.index("-p") + 1] == "xdist"
    assert command.index("-p") < index
    assert command[command.index("--dist") + 1] == "loadfile"
    assert not any(part.startswith("--cov") for part in command)


def test_backend_suite_measures_coverage_when_asked() -> None:
    command = run_ci._backend_suite_command(workers=8, with_coverage=True)

    assert "--cov=backend" in command
    assert "--cov-report=xml:backend/coverage.xml" in command
    assert "-n" in command
    plugins = [command[i + 1] for i, part in enumerate(command) if part == "-p"]
    assert plugins == ["xdist", "pytest_cov"]


def test_one_backend_worker_runs_the_suite_in_one_process() -> None:
    command = run_ci._backend_suite_command(workers=1, with_coverage=False)

    assert "-n" not in command
    assert "--dist" not in command


def test_default_worker_count_is_between_one_and_eight() -> None:
    assert 1 <= run_ci.DEFAULT_BACKEND_WORKERS <= 8


def _capture_run_ci(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, object]]:
    calls: list[dict[str, object]] = []

    def fake_run_ci(*args: object, **kwargs: object) -> int:
        calls.append(kwargs)
        return 0

    monkeypatch.setattr(run_ci, "_run_ci", fake_run_ci)
    monkeypatch.setattr(run_ci, "_exclusive_ci_lock", lambda *args: nullcontext())
    monkeypatch.setattr(
        run_ci, "_require_workspace_lock_runtime_compatibility", lambda *args: None
    )
    return calls


def test_main_defaults_to_parallel_without_coverage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _capture_run_ci(monkeypatch)

    assert run_ci.main([]) == 0

    assert calls == [
        {
            "backend_workers": run_ci.DEFAULT_BACKEND_WORKERS,
            "backend_coverage": False,
        }
    ]


def test_main_passes_the_coverage_and_worker_options(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _capture_run_ci(monkeypatch)

    assert run_ci.main(["--backend-coverage", "--backend-workers", "1"]) == 0

    assert calls == [{"backend_workers": 1, "backend_coverage": True}]


def test_main_rejects_a_worker_count_below_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _capture_run_ci(monkeypatch)

    with pytest.raises(SystemExit):
        run_ci.main(["--backend-workers", "0"])
