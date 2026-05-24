from __future__ import annotations

import platform
import sys

import optional_dependencies


def test_requirement_lock_map_uses_release_pins():
    optional_dependencies._REQUIREMENTS_CACHE = None

    lock_map = optional_dependencies._load_requirement_version_map()

    # The universal lockfile (uv pip compile --universal) resolves a single
    # opencv-python and torch version for all platforms — opencv 4.11.0.86 has
    # wheels for macOS arm64, macOS x86_64, Linux, and Windows; torch 2.11.0
    # has wheels for cp310-cp313 across all of those. The previous test asserted
    # platform-specific pins that only existed because pip-compile was run
    # per-platform; now both pins are platform-agnostic.
    expected_torch = "torch==2.11.0"
    expected_opencv = "opencv-python==4.11.0.86"

    assert lock_map["transformers"] == "transformers==5.6.2"
    assert lock_map["fastembed"] == "fastembed==0.8.0"
    assert lock_map["torch"] == expected_torch
    assert lock_map["opencv_python"] == expected_opencv
    assert optional_dependencies._lock_package_spec("transformers>=5.6.0") == "transformers==5.6.2"
    assert optional_dependencies._lock_package_spec("torch>=2.0.0") == expected_torch


def _fake_install(installed_list):
    """Return a mock install_packages that records calls and returns False (no DLL lock)."""
    def _mock(packages):
        installed_list.extend(packages)
        return False
    return _mock


def test_ensure_group_installs_missing_or_too_old_packages(monkeypatch):
    installed = []

    monkeypatch.setattr(optional_dependencies.importlib.util, "find_spec", lambda module: object())
    monkeypatch.setattr(
        optional_dependencies.importlib.metadata,
        "version",
        lambda package: "5.5.0" if package == "transformers" else "999.0.0",
    )
    monkeypatch.setattr(optional_dependencies, "install_packages", _fake_install(installed))

    result = optional_dependencies.ensure_group("sam3")

    assert installed == ["transformers==5.6.2"]
    assert result.installed_packages == ("transformers==5.6.2",)
    assert result.restart_recommended is True


def test_toriigate_requires_transformers_version_with_qwen35_support(monkeypatch):
    installed = []

    monkeypatch.setattr(optional_dependencies.importlib.util, "find_spec", lambda module: object())
    monkeypatch.setattr(
        optional_dependencies.importlib.metadata,
        "version",
        lambda package: "5.5.0" if package == "transformers" else "999.0.0",
    )
    monkeypatch.setattr(optional_dependencies, "install_packages", _fake_install(installed))

    result = optional_dependencies.ensure_group("toriigate")

    assert installed == ["transformers==5.6.2"]
    assert result.installed_packages == ("transformers==5.6.2",)
    assert result.restart_recommended is True


def test_ensure_group_skips_already_satisfied_packages(monkeypatch):
    installed = []

    monkeypatch.setattr(optional_dependencies.importlib.util, "find_spec", lambda module: object())
    monkeypatch.setattr(optional_dependencies.importlib.metadata, "version", lambda package: "999.0.0")
    monkeypatch.setattr(optional_dependencies, "install_packages", _fake_install(installed))

    result = optional_dependencies.ensure_group("clip")

    assert installed == []
    assert result.installed_packages == ()
    assert result.restart_recommended is False

def test_install_packages_refuses_system_python_without_opt_in(monkeypatch):
    monkeypatch.setattr(optional_dependencies, "_running_in_virtualenv", lambda: False)
    monkeypatch.delenv("SD_IMAGE_SORTER_ALLOW_SYSTEM_PIP_INSTALL", raising=False)

    calls = []
    monkeypatch.setattr(optional_dependencies.subprocess, "run", lambda *args, **kwargs: calls.append((args, kwargs)))

    try:
        optional_dependencies.install_packages(["torch>=2.0.0"])
    except optional_dependencies.UnsafeDependencyInstallError as exc:
        message = str(exc)
    else:
        raise AssertionError("expected UnsafeDependencyInstallError")

    assert "system Python environment" in message
    assert "run-portable.bat" in message
    assert "torch>=2.0.0" in message
    assert calls == []


def test_install_packages_allows_virtualenv(monkeypatch):
    monkeypatch.setattr(optional_dependencies, "_running_in_virtualenv", lambda: True)
    calls = []

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))

    monkeypatch.setattr(optional_dependencies.subprocess, "run", fake_run)
    monkeypatch.setattr(optional_dependencies.importlib, "invalidate_caches", lambda: None)

    optional_dependencies.install_packages(["fastembed>=0.4.0"])

    assert calls
    assert "fastembed>=0.4.0" in calls[0][0]

def test_install_packages_allows_portable_python(monkeypatch, tmp_path):
    package_root = tmp_path / "app"
    backend_dir = package_root / "backend"
    backend_dir.mkdir(parents=True)
    portable_python = package_root / "python" / "python.exe"
    portable_python.parent.mkdir(parents=True)
    portable_python.write_text("", encoding="utf-8")

    monkeypatch.setattr(optional_dependencies, "__file__", str(backend_dir / "optional_dependencies.py"))
    monkeypatch.setattr(optional_dependencies.sys, "executable", str(portable_python))
    monkeypatch.setattr(optional_dependencies, "_running_in_virtualenv", lambda: False)
    monkeypatch.delenv("SD_IMAGE_SORTER_ALLOW_SYSTEM_PIP_INSTALL", raising=False)
    calls = []

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))

    monkeypatch.setattr(optional_dependencies.subprocess, "run", fake_run)
    monkeypatch.setattr(optional_dependencies.importlib, "invalidate_caches", lambda: None)

    optional_dependencies.install_packages(["fastembed>=0.4.0"])

    assert calls
    assert "fastembed>=0.4.0" in calls[0][0]
