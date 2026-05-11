"""Optional dependency installation helpers.

Core startup deliberately avoids GB-scale AI stacks. Feature entry points call
these helpers only after the user explicitly asks to prepare that feature.
"""
from __future__ import annotations

import importlib.metadata
import importlib.util
import os
import re
from pathlib import Path
import subprocess
import sys
from dataclasses import dataclass
from typing import Iterable, Sequence

from packaging.markers import InvalidMarker, Marker


@dataclass(frozen=True)
class DependencyInstallResult:
    installed_packages: tuple[str, ...]
    restart_recommended: bool = False


class UnsafeDependencyInstallError(RuntimeError):
    """Raised when optional packages would be installed outside the app venv."""


_TRITON_PACKAGE = "triton-windows" if sys.platform == "win32" else "triton>=3.0.0"

OPTIONAL_DEPENDENCY_GROUPS: dict[str, tuple[str, ...]] = {
    "clip": ("fastembed>=0.4.0",),
    "aesthetic": ("torch>=2.0.0", "open-clip-torch>=2.24.0"),
    "artist": ("torch>=2.0.0", "transformers>=5.6.0", "timm>=0.9.0", "safetensors>=0.4.0"),
    "nudenet": ("nudenet>=3.0.0",),
    "yolo": ("ultralytics>=8.4.0",),
    "sam3": (
        "torch>=2.0.0",
        "transformers>=5.6.0",
        "safetensors>=0.4.0",
        "opencv-python>=4.9.0",
    ),
    "toriigate": ("torch>=2.0.0", "transformers>=5.6.0", "safetensors>=0.4.0"),
}

SOFT_DEPENDENCY_GROUPS: dict[str, tuple[tuple[str, str], ...]] = {
    "artist": (("triton", _TRITON_PACKAGE),),
}


GROUP_IMPORTS: dict[str, tuple[str, ...]] = {
    "clip": ("fastembed",),
    "aesthetic": ("torch", "open_clip"),
    "artist": ("torch", "transformers", "timm", "safetensors"),
    "nudenet": ("nudenet",),
    "yolo": ("ultralytics",),
    "sam3": ("torch", "transformers", "safetensors", "cv2"),
    "toriigate": ("torch", "transformers", "safetensors"),
}

IMPORT_TO_PACKAGE_HINT: dict[str, str] = {
    "fastembed": "fastembed>=0.4.0",
    "torch": "torch>=2.0.0",
    "open_clip": "open-clip-torch>=2.24.0",
    "transformers": "transformers>=5.6.0",
    "timm": "timm>=0.9.0",
    "safetensors": "safetensors>=0.4.0",
    "nudenet": "nudenet>=3.0.0",
    "ultralytics": "ultralytics>=8.4.0",
    "cv2": "opencv-python>=4.9.0",
    "triton": _TRITON_PACKAGE,
}


_REQUIREMENTS_CACHE: dict[str, str] | None = None


def _normalize_package_name(package_name: str) -> str:
    return package_name.lower().replace("-", "_")


def _requirement_marker_matches(marker_text: str | None) -> bool:
    if not marker_text:
        return True
    try:
        return Marker(marker_text).evaluate()
    except InvalidMarker:
        return False


def _load_requirement_version_map() -> dict[str, str]:
    global _REQUIREMENTS_CACHE
    if _REQUIREMENTS_CACHE is not None:
        return _REQUIREMENTS_CACHE

    mapping: dict[str, str] = {}
    requirements_path = Path(__file__).resolve().parent / "requirements.txt"
    if not requirements_path.exists():
        _REQUIREMENTS_CACHE = mapping
        return mapping

    requirement_line = re.compile(
        r"^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?\s*(==|>=)\s*([^;\s]+)(?:\s*;\s*(.+))?$"
    )
    for raw_line in requirements_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or line.startswith("-"):
            continue
        match = requirement_line.match(line)
        if not match:
            continue
        package_name, _operator, version, marker_text = match.groups()
        if not _requirement_marker_matches(marker_text):
            continue
        normalized = _normalize_package_name(package_name)
        mapping[normalized] = f"{package_name}=={version.strip()}"

    _REQUIREMENTS_CACHE = mapping
    return mapping


def _lock_package_spec(package_spec: str) -> str:
    match = re.match(r"^([A-Za-z0-9_.-]+)\s*(==|>=)\s*([^;\[]+)", package_spec)
    if not match:
        lock_map = _load_requirement_version_map()
        return lock_map.get(_normalize_package_name(package_spec), package_spec)

    package_name, operator, _required_version = match.groups()
    if operator != ">=":
        return package_spec

    lock_map = _load_requirement_version_map()
    locked = lock_map.get(_normalize_package_name(package_name))
    return locked or package_spec

def missing_imports(module_names: Iterable[str]) -> list[str]:
    return [module_name for module_name in module_names if importlib.util.find_spec(module_name) is None]


def _version_tuple(version: str) -> tuple[int, ...]:
    parts = []
    for part in re.split(r"[.+!-]", version):
        if not part.isdigit():
            break
        parts.append(int(part))
    return tuple(parts)


def _installed_version_satisfies(package_spec: str) -> bool:
    match = re.match(r"^([A-Za-z0-9_.-]+)\s*(==|>=)\s*([^;\[]+)", package_spec)
    if not match:
        return True
    package_name, operator, required_version = match.groups()
    try:
        installed_version = importlib.metadata.version(package_name)
    except importlib.metadata.PackageNotFoundError:
        return False

    installed = _version_tuple(installed_version)
    required = _version_tuple(required_version.strip())
    if not installed or not required:
        return True
    if operator == "==":
        return installed == required
    return installed >= required


def _needs_install(module_name: str, package_spec: str) -> bool:
    return importlib.util.find_spec(module_name) is None or not _installed_version_satisfies(package_spec)


def _running_in_virtualenv() -> bool:
    return bool(getattr(sys, "base_prefix", sys.prefix) != sys.prefix or getattr(sys, "real_prefix", None))


def _running_in_portable_python() -> bool:
    try:
        package_root = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
        portable_python_root = os.path.normcase(os.path.abspath(os.path.join(package_root, "python")))
        executable = os.path.normcase(os.path.abspath(sys.executable))
        return os.path.commonpath([executable, portable_python_root]) == portable_python_root
    except (OSError, ValueError):
        return False


def _allow_system_python_install() -> bool:
    return os.environ.get("SD_IMAGE_SORTER_ALLOW_SYSTEM_PIP_INSTALL") == "1"


def _assert_safe_install_target(packages: Sequence[str]) -> None:
    if not packages or _running_in_virtualenv() or _running_in_portable_python() or _allow_system_python_install():
        return
    package_list = ", ".join(packages)
    raise UnsafeDependencyInstallError(
        "Refusing to install optional AI Python packages into the system Python environment. "
        "Start SD Image Sorter with run.bat, run-portable.bat, or run.sh so the app-owned Python runtime is used, then click Prepare again. "
        "If you are intentionally managing your own environment, create/activate a virtual environment first "
        "or set SD_IMAGE_SORTER_ALLOW_SYSTEM_PIP_INSTALL=1. "
        f"Packages not installed: {package_list}"
    )


def install_packages(packages: Sequence[str]) -> None:
    if not packages:
        return
    _assert_safe_install_target(packages)
    subprocess.run(
        [sys.executable, "-m", "pip", "--disable-pip-version-check", "install", *packages],
        check=True,
        text=True,
    )
    importlib.invalidate_caches()


def ensure_imports(module_names: Iterable[str]) -> DependencyInstallResult:
    packages = []
    for module_name in module_names:
        package_spec = IMPORT_TO_PACKAGE_HINT.get(module_name, module_name)
        locked_package = _lock_package_spec(package_spec)
        if _needs_install(module_name, package_spec) and locked_package not in packages:
            packages.append(locked_package)
    install_packages(packages)
    return DependencyInstallResult(
        installed_packages=tuple(packages),
        restart_recommended=bool(packages),
    )


def ensure_group(group: str) -> DependencyInstallResult:
    packages = OPTIONAL_DEPENDENCY_GROUPS.get(group)
    imports = GROUP_IMPORTS.get(group)
    if not packages or imports is None:
        raise ValueError(f"Unknown optional dependency group: {group}")

    packages_to_install = []
    for module_name, package in zip(imports, packages):
        locked_package = _lock_package_spec(package)
        if _needs_install(module_name, package) and locked_package not in packages_to_install:
            packages_to_install.append(locked_package)

    install_packages(packages_to_install)
    return DependencyInstallResult(
        installed_packages=tuple(packages_to_install),
        restart_recommended=bool(packages_to_install),
    )


import logging as _logging

_dep_logger = _logging.getLogger("sd-image-sorter.deps")


def ensure_group_with_soft_deps(group: str) -> DependencyInstallResult:
    """Install core group deps, then best-effort install soft deps (triton etc.).

    Soft deps failing does NOT block the core install or raise an error.
    """
    result = ensure_group(group)
    soft_entries = SOFT_DEPENDENCY_GROUPS.get(group)
    if not soft_entries:
        return result

    soft_installed: list[str] = []
    for module_name, package_spec in soft_entries:
        locked_package = _lock_package_spec(package_spec)
        if not _needs_install(module_name, package_spec):
            continue
        try:
            install_packages([locked_package])
            soft_installed.append(locked_package)
        except Exception as exc:
            _dep_logger.warning(
                "Optional package %s could not be installed (non-fatal): %s",
                package_spec,
                exc,
            )

    all_installed = list(result.installed_packages) + soft_installed
    return DependencyInstallResult(
        installed_packages=tuple(all_installed),
        restart_recommended=bool(all_installed),
    )
