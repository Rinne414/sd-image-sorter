"""Regression tests for the OSError catch in _needs_install.

Background
==========
Real-world failure on a Windows + CUDA system: triggering the censor-legacy
prepare returned ``[WinError 127] cudnn_cnn64_9.dll`` because torch's cudnn
DLL chain failed at import time. The previous ``_needs_install`` only
caught ``ImportError`` so an ``OSError`` (which is what Windows raises for
DLL load failures) bubbled all the way to the prepare endpoint and was
shown to the user as raw [WinError 127].

The fix treats DLL load failures the same as missing packages - trigger a
reinstall - so the prepare flow has a chance to recover instead of dying
on an opaque error.
"""
from __future__ import annotations

import builtins


import optional_dependencies


def _fake_install(installed_list):
    def _mock(packages):
        installed_list.extend(packages)
        return False
    return _mock


def _locked_version(package_name: str) -> str:
    normalized = optional_dependencies._normalize_package_name(package_name)
    locked_spec = optional_dependencies._load_requirement_version_map()[normalized]
    prefix = f"{package_name}=="
    if not locked_spec.startswith(prefix):
        raise AssertionError(
            f"Expected an exact release lock for {package_name}: {locked_spec}"
        )
    return locked_spec[len(prefix):]


def _patch_module_already_installed(monkeypatch):
    monkeypatch.setattr(optional_dependencies.platform, "system", lambda: "Windows")
    monkeypatch.setattr(
        optional_dependencies.importlib.util, "find_spec", lambda module: object()
    )
    monkeypatch.setattr(
        optional_dependencies.importlib.metadata,
        "version",
        _locked_version,
    )


def test_dll_load_failure_triggers_reinstall(monkeypatch):
    """OSError during __import__ (DLL load failure) should NOT bubble up."""
    _patch_module_already_installed(monkeypatch)
    installed: list[str] = []
    monkeypatch.setattr(optional_dependencies, "install_packages", _fake_install(installed))

    real_import = builtins.__import__

    def import_with_dll_error(name, *args, **kwargs):
        if name == "ultralytics":
            raise OSError(
                127,
                "[WinError 127] 找不到指定的程序。 Error loading "
                "\"L:\\\\path\\\\to\\\\torch\\\\lib\\\\cudnn_cnn64_9.dll\" "
                "or one of its dependencies.",
            )
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", import_with_dll_error)

    # Should not raise; should attempt reinstall.
    result = optional_dependencies.ensure_group("yolo")

    assert "ultralytics==" in (result.installed_packages[0] if result.installed_packages else ""), (
        f"Expected ultralytics reinstall to be triggered, got {result.installed_packages}"
    )


def test_import_error_still_triggers_reinstall(monkeypatch):
    """The original ImportError path still works."""
    _patch_module_already_installed(monkeypatch)
    installed: list[str] = []
    monkeypatch.setattr(optional_dependencies, "install_packages", _fake_install(installed))

    real_import = builtins.__import__

    def import_with_module_error(name, *args, **kwargs):
        if name == "ultralytics":
            raise ImportError("ultralytics is broken")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", import_with_module_error)

    result = optional_dependencies.ensure_group("yolo")
    assert "ultralytics==" in (result.installed_packages[0] if result.installed_packages else "")


def test_clean_import_does_not_trigger_reinstall(monkeypatch):
    """A successful import should not trigger reinstall."""
    _patch_module_already_installed(monkeypatch)
    installed: list[str] = []
    monkeypatch.setattr(optional_dependencies, "install_packages", _fake_install(installed))

    real_import = builtins.__import__

    def import_returns_module(name, *args, **kwargs):
        if name == "ultralytics":
            class _FakeModule:
                pass
            return _FakeModule()
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", import_returns_module)

    result = optional_dependencies.ensure_group("yolo")
    assert result.installed_packages == ()
    assert installed == []


def test_dll_load_failure_for_fastembed(monkeypatch):
    """Same OSError-fallback applies to fastembed."""
    _patch_module_already_installed(monkeypatch)
    installed: list[str] = []
    monkeypatch.setattr(optional_dependencies, "install_packages", _fake_install(installed))

    real_import = builtins.__import__

    def import_with_dll_error(name, *args, **kwargs):
        if name == "fastembed":
            raise OSError("DLL load failed: a runtime is missing")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", import_with_dll_error)

    result = optional_dependencies.ensure_group("clip")
    assert any("fastembed" in spec for spec in result.installed_packages)


def test_dll_load_failure_for_nudenet(monkeypatch):
    """Same OSError-fallback applies to nudenet."""
    _patch_module_already_installed(monkeypatch)
    installed: list[str] = []
    monkeypatch.setattr(optional_dependencies, "install_packages", _fake_install(installed))

    real_import = builtins.__import__

    def import_with_dll_error(name, *args, **kwargs):
        if name == "nudenet":
            raise OSError(126, "DLL load failed")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", import_with_dll_error)

    result = optional_dependencies.ensure_group("nudenet")
    assert any("nudenet" in spec for spec in result.installed_packages)
