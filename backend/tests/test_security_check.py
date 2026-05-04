from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path
from types import SimpleNamespace


def _load_security_check():
    script_path = Path(__file__).resolve().parents[2] / "scripts" / "security_check.py"
    spec = importlib.util.spec_from_file_location("security_check_under_test", script_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_run_pip_audit_uses_locked_requirements_without_dependency_resolution(monkeypatch):
    security_check = _load_security_check()
    calls: list[list[str]] = []

    def fake_run(command, **kwargs):
        calls.append(command)
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(security_check.subprocess, "run", fake_run)

    assert security_check.run_pip_audit("backend/requirements.txt", "/tmp/python") == 0

    assert calls == [[
        "/tmp/python",
        "-m",
        "pip_audit",
        "-r",
        "backend/requirements.txt",
        "--progress-spinner",
        "off",
        "--no-deps",
        "--disable-pip",
    ]]


def test_ensure_pip_audit_runner_reuses_current_interpreter_when_available(monkeypatch):
    security_check = _load_security_check()
    monkeypatch.setattr(security_check, "_python_has_pip_audit", lambda python: True)

    assert security_check.ensure_pip_audit_runner() == security_check.sys.executable


def test_ensure_pip_audit_runner_uses_existing_temp_venv_without_global_install(monkeypatch, tmp_path: Path):
    security_check = _load_security_check()
    venv_python = tmp_path / "pip-audit-venv" / "bin" / "python"
    venv_python.parent.mkdir(parents=True)
    venv_python.write_text("python", encoding="utf-8")

    def fake_has_pip_audit(python: str) -> bool:
        return Path(python) == venv_python

    monkeypatch.setattr(security_check, "_python_has_pip_audit", fake_has_pip_audit)
    monkeypatch.setattr(security_check.tempfile, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(security_check, "_venv_python", lambda _venv_dir: venv_python)
    monkeypatch.setattr(security_check, "_create_pip_audit_venv", lambda _venv_dir: (_ for _ in ()).throw(AssertionError("should reuse existing venv")))
    monkeypatch.setattr(security_check, "install_pip_audit", lambda _python: (_ for _ in ()).throw(AssertionError("should not install globally")))

    assert security_check.ensure_pip_audit_runner() == str(venv_python)


def test_create_pip_audit_venv_falls_back_to_without_pip_system_site_packages(monkeypatch, tmp_path: Path):
    security_check = _load_security_check()
    calls: list[list[str]] = []
    venv_python = tmp_path / "venv" / "bin" / "python"

    class FailingEnvBuilder:
        def __init__(self, *, with_pip: bool):
            assert with_pip is True

        def create(self, _venv_dir: Path) -> None:
            raise RuntimeError("ensurepip unavailable")

    def fake_check_call(command: list[str]) -> None:
        calls.append(command)
        venv_python.parent.mkdir(parents=True)
        venv_python.write_text("python", encoding="utf-8")

    monkeypatch.setattr(security_check.venv, "EnvBuilder", FailingEnvBuilder)
    monkeypatch.setattr(security_check.subprocess, "check_call", fake_check_call)
    monkeypatch.setattr(security_check, "_venv_python", lambda _venv_dir: venv_python)

    assert security_check._create_pip_audit_venv(tmp_path / "venv") is True
    assert calls == [[
        security_check.sys.executable,
        "-m",
        "venv",
        "--without-pip",
        "--system-site-packages",
        str(tmp_path / "venv"),
    ]]
