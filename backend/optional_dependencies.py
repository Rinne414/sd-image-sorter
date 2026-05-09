"""Optional dependency installation helpers.

Core startup deliberately avoids GB-scale AI stacks. Feature entry points call
these helpers only after the user explicitly asks to prepare that feature.
"""
from __future__ import annotations

import importlib.metadata
import importlib.util
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from typing import Iterable, Sequence


@dataclass(frozen=True)
class DependencyInstallResult:
    installed_packages: tuple[str, ...]
    restart_recommended: bool = False


class UnsafeDependencyInstallError(RuntimeError):
    """Raised when optional packages would be installed outside the app venv."""


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
}


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
        package = IMPORT_TO_PACKAGE_HINT.get(module_name, module_name)
        if _needs_install(module_name, package) and package not in packages:
            packages.append(package)
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
        if _needs_install(module_name, package) and package not in packages_to_install:
            packages_to_install.append(package)

    install_packages(packages_to_install)
    return DependencyInstallResult(
        installed_packages=tuple(packages_to_install),
        restart_recommended=bool(packages_to_install),
    )
