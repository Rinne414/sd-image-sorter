from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

import launcher_v4_build


ROOT = Path(__file__).resolve().parents[2]


def _touch(path: Path, mtime: float, content: str = "x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    os.utime(path, (mtime, mtime))
    return path


def _source_checkout(tmp_path: Path, *, inputs_at: float = 1_000.0) -> Path:
    frontend = tmp_path / "frontend-v4"
    _touch(frontend / "package.json", inputs_at, "{}")
    _touch(frontend / "package-lock.json", inputs_at, "{}")
    _touch(frontend / "index.html", inputs_at)
    _touch(frontend / "vite.config.ts", inputs_at)
    _touch(frontend / "src" / "main.tsx", inputs_at)
    _touch(frontend / "src" / "features" / "gallery" / "Grid.tsx", inputs_at)
    return frontend


def _installed(frontend: Path, at: float) -> None:
    _touch(frontend / "node_modules" / ".package-lock.json", at, "{}")


def _built(frontend: Path, at: float) -> None:
    _touch(frontend / "dist" / "index.html", at)


def test_plan_skips_a_packaged_install_that_has_no_frontend_sources(tmp_path):
    frontend = tmp_path / "frontend-v4"
    _built(frontend, 500.0)

    assert launcher_v4_build.plan_build(frontend) == "none"
    assert launcher_v4_build.plan_build(tmp_path / "missing") == "none"


def test_plan_skips_when_the_build_is_newer_than_every_input(tmp_path):
    frontend = _source_checkout(tmp_path)
    _installed(frontend, 1_100.0)
    _built(frontend, 1_200.0)

    assert launcher_v4_build.plan_build(frontend) == "none"


def test_plan_builds_when_dist_is_missing(tmp_path):
    frontend = _source_checkout(tmp_path)
    _installed(frontend, 1_100.0)

    assert launcher_v4_build.plan_build(frontend) == "build"


def test_plan_builds_when_a_nested_source_file_is_newer_than_dist(tmp_path):
    frontend = _source_checkout(tmp_path)
    _installed(frontend, 1_100.0)
    _built(frontend, 1_200.0)
    _touch(frontend / "src" / "features" / "gallery" / "Grid.tsx", 1_300.0)

    assert launcher_v4_build.plan_build(frontend) == "build"


def test_plan_installs_when_node_modules_is_missing(tmp_path):
    frontend = _source_checkout(tmp_path)

    assert launcher_v4_build.plan_build(frontend) == "install"


def test_plan_installs_when_node_modules_is_older_than_the_lockfile(tmp_path):
    frontend = _source_checkout(tmp_path)
    _installed(frontend, 1_100.0)
    _built(frontend, 1_200.0)
    _touch(frontend / "package-lock.json", 1_300.0, "{}")

    assert launcher_v4_build.plan_build(frontend) == "install"


def _record_npm(
    monkeypatch, *, returncodes: dict[str, int] | None = None
) -> list[tuple[list[str], Path]]:
    calls: list[tuple[list[str], Path]] = []
    codes = returncodes or {}

    def fake_run(command, cwd=None, **_kwargs):
        calls.append((list(command), Path(cwd)))
        return subprocess.CompletedProcess(command, codes.get(" ".join(command[1:]), 0))

    monkeypatch.setattr(
        launcher_v4_build.shutil,
        "which",
        lambda name: "C:/node/npm.cmd" if name == "npm" else None,
    )
    monkeypatch.setattr(launcher_v4_build.subprocess, "run", fake_run)
    return calls


def test_build_if_needed_installs_then_builds_in_the_frontend_folder(
    monkeypatch, tmp_path, capsys
):
    frontend = _source_checkout(tmp_path)
    calls = _record_npm(monkeypatch)

    assert launcher_v4_build.build_if_needed(frontend) == 0

    assert calls == [
        (["C:/node/npm.cmd", "ci"], frontend),
        (["C:/node/npm.cmd", "run", "build"], frontend),
    ]
    assert "/v4/" in capsys.readouterr().out


def test_build_if_needed_only_builds_when_node_modules_is_current(
    monkeypatch, tmp_path
):
    frontend = _source_checkout(tmp_path)
    _installed(frontend, 1_100.0)
    calls = _record_npm(monkeypatch)

    assert launcher_v4_build.build_if_needed(frontend) == 0

    assert [command[1:] for command, _cwd in calls] == [["run", "build"]]


def test_build_if_needed_runs_nothing_when_up_to_date(monkeypatch, tmp_path, capsys):
    frontend = _source_checkout(tmp_path)
    _installed(frontend, 1_100.0)
    _built(frontend, 1_200.0)
    calls = _record_npm(monkeypatch)

    assert launcher_v4_build.build_if_needed(frontend) == 0

    assert calls == []
    assert capsys.readouterr().out == ""


def test_build_if_needed_without_npm_prints_one_bilingual_line_and_continues(
    monkeypatch, tmp_path, capsys
):
    frontend = _source_checkout(tmp_path)
    monkeypatch.setattr(launcher_v4_build.shutil, "which", lambda name: None)

    def fail_run(*_args, **_kwargs):
        raise AssertionError("npm must not run when it is missing")

    monkeypatch.setattr(launcher_v4_build.subprocess, "run", fail_run)

    assert launcher_v4_build.build_if_needed(frontend) == 0

    lines = [line for line in capsys.readouterr().out.splitlines() if line.strip()]
    assert len(lines) == 1
    assert "Node.js" in lines[0]
    assert "Vopus" in lines[0]
    assert "V3.5" not in lines[0]
    assert "需要" in lines[0]


def test_build_if_needed_reports_a_failed_build_and_still_exits_zero(
    monkeypatch, tmp_path, capsys
):
    frontend = _source_checkout(tmp_path)
    _installed(frontend, 1_100.0)
    calls = _record_npm(monkeypatch, returncodes={"run build": 2})

    assert launcher_v4_build.build_if_needed(frontend) == 0

    assert len(calls) == 1
    out = capsys.readouterr().out
    assert "Vopus" in out
    assert "失败" in out


def test_build_if_needed_stops_after_a_failed_install(monkeypatch, tmp_path, capsys):
    frontend = _source_checkout(tmp_path)
    calls = _record_npm(monkeypatch, returncodes={"ci": 1})

    assert launcher_v4_build.build_if_needed(frontend) == 0

    assert [command[1:] for command, _cwd in calls] == [["ci"]]
    assert "Vopus" in capsys.readouterr().out


def test_build_if_needed_survives_npm_that_cannot_start(monkeypatch, tmp_path, capsys):
    frontend = _source_checkout(tmp_path)
    monkeypatch.setattr(
        launcher_v4_build.shutil, "which", lambda name: "C:/node/npm.cmd"
    )

    def broken_run(*_args, **_kwargs):
        raise OSError("npm.cmd is locked")

    monkeypatch.setattr(launcher_v4_build.subprocess, "run", broken_run)

    assert launcher_v4_build.build_if_needed(frontend) == 0
    assert "npm.cmd is locked" in capsys.readouterr().out


@pytest.mark.parametrize("launcher", ["run.bat", "run.sh"])
def test_source_launchers_build_v4_through_the_helper_without_powershell(launcher):
    text = (ROOT / launcher).read_text(encoding="utf-8")

    assert "launcher_v4_build.py" in text
    lowered = text.lower()
    for forbidden in ("powershell", "pwsh", "windowstyle hidden", "start /b"):
        assert forbidden not in lowered


def test_run_sh_keeps_starting_v35_when_the_v4_step_fails():
    run_sh = (ROOT / "run.sh").read_text(encoding="utf-8")
    v4_line = next(
        line for line in run_sh.splitlines() if "launcher_v4_build.py" in line
    )

    assert "|| true" in v4_line
    assert run_sh.index("launcher_v4_build.py") < run_sh.index("main.py --port")


def test_run_bat_builds_v4_before_starting_the_server_and_never_exits_on_it():
    run_bat = (ROOT / "run.bat").read_text(encoding="utf-8")
    lines = run_bat.splitlines()
    v4_index = next(
        index for index, line in enumerate(lines) if "launcher_v4_build.py" in line
    )

    assert run_bat.index("launcher_v4_build.py") < run_bat.index("main.py --port")
    following = "\n".join(lines[v4_index + 1 : v4_index + 4]).lower()
    assert "exit /b" not in following
