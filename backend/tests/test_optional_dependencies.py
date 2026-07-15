from __future__ import annotations

import platform
import sys
from pathlib import Path

import pytest

import optional_dependencies


def test_requirement_lock_map_uses_release_pins():
    optional_dependencies._REQUIREMENTS_CACHE = None

    lock_map = optional_dependencies._load_requirement_version_map()

    # The universal lock keeps the security-supported Torch pair current.
    # Intel Mac and pre-14 Apple Silicon are rejected before optional install.
    # OpenCV retains its separate legacy macOS wheel compatibility markers.
    expected_torch = "torch==2.13.0"
    expected_opencv = (
        "opencv-python==4.10.0.84"
        if sys.platform == "darwin" and platform.machine() == "arm64"
        else "opencv-python==4.9.0.80"
        if sys.platform == "darwin"
        else "opencv-python==4.11.0.86"
    )

    assert lock_map["transformers"] == "transformers==5.6.2"
    assert lock_map["fastembed"] == "fastembed==0.8.0"
    assert lock_map["torch"] == expected_torch
    assert lock_map["opencv_python"] == expected_opencv
    assert optional_dependencies._lock_package_spec("transformers>=5.6.0") == "transformers==5.6.2"
    assert optional_dependencies._lock_package_spec("torch>=2.0.0") == expected_torch


def test_torch_lock_excludes_vulnerable_macos_legacy_pins():
    requirements_path = Path(__file__).resolve().parents[1] / "requirements.in"
    requirements_text = requirements_path.read_text(encoding="utf-8")

    assert "torch==2.2.2" not in requirements_text
    assert "torch==2.10.0" not in requirements_text
    assert "torchvision==0.17.2" not in requirements_text
    assert "torchvision==0.25.0" not in requirements_text
    assert (
        'torch==2.13.0; sys_platform != "darwin" or platform_machine == "arm64"'
        in requirements_text
    )


@pytest.mark.parametrize(
    "group",
    ("aesthetic", "artist", "sam3", "toriigate", "yolo"),
)
def test_torch_group_rejects_intel_macos_before_install(monkeypatch, group):
    monkeypatch.setattr(optional_dependencies.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(optional_dependencies.platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(
        optional_dependencies,
        "_needs_install",
        lambda module_name, package_spec: False,
    )

    with pytest.raises(
        optional_dependencies.UnsupportedOptionalDependencyError,
        match="Intel Mac|CUDA-only",
    ):
        optional_dependencies.ensure_group(group)


def test_torch_group_rejects_pre_14_macos_before_install(monkeypatch):
    monkeypatch.setattr(optional_dependencies.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(optional_dependencies.platform, "machine", lambda: "arm64")
    monkeypatch.setattr(
        optional_dependencies.platform,
        "mac_ver",
        lambda: ("13.6.9", ("", "", ""), "arm64"),
    )
    monkeypatch.setattr(
        optional_dependencies,
        "_needs_install",
        lambda module_name, package_spec: False,
    )

    with pytest.raises(
        optional_dependencies.UnsupportedOptionalDependencyError,
        match="macOS 14",
    ):
        optional_dependencies.ensure_group("toriigate")


def test_torch_group_allows_macos_14_apple_silicon(monkeypatch):
    monkeypatch.setattr(optional_dependencies.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(optional_dependencies.platform, "machine", lambda: "arm64")
    monkeypatch.setattr(
        optional_dependencies.platform,
        "mac_ver",
        lambda: ("14.7.1", ("", "", ""), "arm64"),
    )
    monkeypatch.setattr(
        optional_dependencies,
        "_needs_install",
        lambda module_name, package_spec: False,
    )

    result = optional_dependencies.ensure_group("aesthetic")

    assert result == optional_dependencies.DependencyInstallResult(
        installed_packages=(),
    )

def test_sam3_group_rejects_macos_14_apple_silicon(monkeypatch):
    monkeypatch.setattr(optional_dependencies.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(optional_dependencies.platform, "machine", lambda: "arm64")
    monkeypatch.setattr(
        optional_dependencies.platform,
        "mac_ver",
        lambda: ("14.7.1", ("", "", ""), "arm64"),
    )
    monkeypatch.setattr(
        optional_dependencies,
        "_needs_install",
        lambda module_name, package_spec: False,
    )

    with pytest.raises(
        optional_dependencies.UnsupportedOptionalDependencyError,
        match="CUDA-only",
    ):
        optional_dependencies.ensure_group("sam3")


def _fake_install(installed_list):
    """Return a mock install_packages that records calls and returns False (no DLL lock)."""
    def _mock(packages):
        installed_list.extend(packages)
        return False
    return _mock


def _release_locked_version(package_name: str) -> str:
    normalized = optional_dependencies._normalize_package_name(package_name)
    locked_spec = optional_dependencies._load_requirement_version_map()[normalized]
    operator, separator, version = locked_spec.partition("==")
    if not separator or not operator or not version:
        raise AssertionError(f"Expected an exact release lock for {package_name}: {locked_spec}")
    return version

@pytest.mark.parametrize(
    ("installed_version", "package_spec", "expected"),
    (
        ("2.13.0+cu130", "torch==2.13.0", True),
        ("2.13.0.post1", "torch==2.13.0", False),
        ("2.13.0rc1", "torch==2.13.0", False),
        ("2.13.1", "torch>=2.13.0", True),
    ),
)
def test_installed_version_satisfies_uses_pep440(
    monkeypatch,
    installed_version,
    package_spec,
    expected,
):
    monkeypatch.setattr(
        optional_dependencies.importlib.metadata,
        "version",
        lambda package_name: installed_version,
    )

    assert optional_dependencies._installed_version_satisfies(package_spec) is expected


def test_installed_version_satisfies_rejects_invalid_installed_version(monkeypatch):
    monkeypatch.setattr(
        optional_dependencies.importlib.metadata,
        "version",
        lambda package_name: "not-a-version",
    )

    with pytest.raises(RuntimeError, match="invalid installed version"):
        optional_dependencies._installed_version_satisfies("torch==2.13.0")



def test_ensure_group_installs_missing_or_too_old_packages(monkeypatch):
    installed = []

    monkeypatch.setattr(optional_dependencies.platform, "system", lambda: "Windows")
    monkeypatch.setattr(optional_dependencies.importlib.util, "find_spec", lambda module: object())
    monkeypatch.setattr(
        optional_dependencies.importlib.metadata,
        "version",
        lambda package: "5.5.0" if package == "transformers" else _release_locked_version(package),
    )
    monkeypatch.setattr(optional_dependencies, "install_packages", _fake_install(installed))

    result = optional_dependencies.ensure_group("sam3")

    assert installed == ["transformers==5.6.2"]
    assert result.installed_packages == ("transformers==5.6.2",)
    assert result.restart_recommended is True

def test_ensure_group_upgrades_torch_to_release_lock(monkeypatch):
    installed = []

    monkeypatch.setattr(optional_dependencies.importlib.util, "find_spec", lambda module: object())
    monkeypatch.setattr(optional_dependencies.platform, "system", lambda: "Windows")
    monkeypatch.setattr(
        optional_dependencies.importlib.metadata,
        "version",
        lambda package: {
            "torch": "2.10.0",
            "open-clip-torch": "3.3.0",
        }[package],
    )
    monkeypatch.setattr(optional_dependencies, "install_packages", _fake_install(installed))

    result = optional_dependencies.ensure_group("aesthetic")

    assert installed == ["torch==2.13.0"]
    assert result.installed_packages == ("torch==2.13.0",)

def test_yolo_group_upgrades_transitive_torch_to_release_lock(monkeypatch):
    installed = []

    monkeypatch.setattr(optional_dependencies.platform, "system", lambda: "Windows")
    monkeypatch.setattr(optional_dependencies.importlib.util, "find_spec", lambda module: object())
    monkeypatch.setitem(sys.modules, "ultralytics", type(sys)("ultralytics"))
    monkeypatch.setattr(
        optional_dependencies.importlib.metadata,
        "version",
        lambda package: (
            "2.10.0"
            if package == "torch"
            else _release_locked_version(package)
        ),
    )
    monkeypatch.setattr(optional_dependencies, "install_packages", _fake_install(installed))

    result = optional_dependencies.ensure_group("yolo")

    assert installed == ["torch==2.13.0"]
    assert result.installed_packages == ("torch==2.13.0",)




def test_toriigate_requires_transformers_version_with_qwen35_support(monkeypatch):
    installed = []

    monkeypatch.setattr(optional_dependencies.importlib.util, "find_spec", lambda module: object())
    monkeypatch.setattr(optional_dependencies.platform, "system", lambda: "Windows")
    monkeypatch.setattr(
        optional_dependencies.importlib.metadata,
        "version",
        lambda package: "5.5.0" if package == "transformers" else _release_locked_version(package),
    )
    monkeypatch.setattr(optional_dependencies, "install_packages", _fake_install(installed))

    result = optional_dependencies.ensure_group("toriigate")

    assert installed == ["transformers==5.6.2"]
    assert result.installed_packages == ("transformers==5.6.2",)
    assert result.restart_recommended is True


def test_ensure_group_skips_already_satisfied_packages(monkeypatch):
    installed = []

    monkeypatch.setattr(optional_dependencies.importlib.util, "find_spec", lambda module: object())
    monkeypatch.setattr(optional_dependencies.importlib.metadata, "version", _release_locked_version)
    monkeypatch.setattr(optional_dependencies.platform, "system", lambda: "Windows")
    monkeypatch.setattr(optional_dependencies, "install_packages", _fake_install(installed))

    result = optional_dependencies.ensure_group("aesthetic")

    assert installed == []
    assert result.installed_packages == ()
    assert result.restart_recommended is False


def test_translation_group_installs_translators_runtime(monkeypatch):
    installed = []

    monkeypatch.setattr(optional_dependencies.importlib.util, "find_spec", lambda module: None if module == "translators" else object())
    monkeypatch.setattr(optional_dependencies, "install_packages", _fake_install(installed))

    result = optional_dependencies.ensure_group("translation")

    assert installed == ["translators==6.0.4"]
    assert result.installed_packages == ("translators==6.0.4",)
    assert result.restart_recommended is True


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
