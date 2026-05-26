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
import logging
import platform
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
    "translation": ("translators==6.0.4",),
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
    "translation": ("translators",),
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
    "translators": "translators==6.0.4",
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
    """Check if a module needs installation.

    Beyond find_spec + version check, attempts a real import for packages
    known to fail when installed with --no-deps (missing transitive deps).
    """
    if importlib.util.find_spec(module_name) is None:
        return True
    if not _installed_version_satisfies(package_spec):
        return True
    # Packages that are known to break when installed with --no-deps
    # (their top-level __init__.py imports sub-dependencies immediately).
    _NO_DEPS_FRAGILE = {"fastembed", "nudenet", "ultralytics"}
    if module_name in _NO_DEPS_FRAGILE:
        try:
            __import__(module_name)
        except ImportError:
            return True
        except OSError as exc:
            # torch's cudnn / cuda DLL chain raises OSError (Windows
            # error 127 / 126) when a runtime DLL fails to load. The
            # previous narrow ``except ImportError`` let those bubble
            # up as raw "[WinError 127] cudnn_cnn64_9.dll" errors in
            # the prepare flow. Treat them as "needs reinstall" so the
            # downstream pipeline at least attempts a repair, and log
            # the underlying OS error so the user can find it. If the
            # reinstall doesn't fix it, the problem is system-level
            # (CUDA toolkit / VC++ runtime) and the user should run
            # the dedicated torch-runtime repair tool.
            logging.getLogger(__name__).warning(
                "Optional package %s could not be imported even though it is "
                "installed - DLL load failed with %s. Triggering reinstall.",
                module_name,
                exc,
            )
            return True
    return False


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
        "Refusing to install optional Python packages into the system Python environment. "
        "Start SD Image Sorter with run.bat, run-portable.bat, or run.sh so the app-owned Python runtime is used, then click Prepare again. "
        "If you are intentionally managing your own environment, create/activate a virtual environment first "
        "or set SD_IMAGE_SORTER_ALLOW_SYSTEM_PIP_INSTALL=1. "
        f"Packages not installed: {package_list}"
    )


_log = logging.getLogger(__name__)

_WINDOWS_DLL_LOCK_MARKERS = ("WinError 5", "Access is denied", "存取被拒")


def install_packages(packages: Sequence[str]) -> bool:
    """Install packages via pip. Returns True if a DLL-lock fallback was used."""
    if not packages:
        return False
    _assert_safe_install_target(packages)

    # Use the fastest PyPI mirror (cached 30 min) so runtime installs
    # don't crawl on slow paths to pypi.org's Fastly CDN.
    index_args: list[str] = []
    try:
        from config import get_data_dir
        import mirror_selector
        selection = mirror_selector.select_pypi_index(data_dir=get_data_dir())
        if selection and selection.url:
            index_args = ["--index-url", selection.url, "--extra-index-url", "https://pypi.org/simple"]
    except Exception:
        pass  # fall back to default PyPI

    try:
        subprocess.run(
            [sys.executable, "-m", "pip", "--disable-pip-version-check", "install", *index_args, *packages],
            check=True,
            text=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "") + (exc.stdout or "")
        if platform.system() == "Windows" and any(m in stderr for m in _WINDOWS_DLL_LOCK_MARKERS):
            _log.warning(
                "pip install hit a locked DLL (another model loaded the same native library). "
                "Retrying with --no-deps to install the pure-Python portion..."
            )
            subprocess.run(
                [sys.executable, "-m", "pip", "--disable-pip-version-check", "install", "--no-deps", *index_args, *packages],
                check=True,
                text=True,
            )
            # --no-deps skips transitive dependencies. Run a second pass that
            # asks pip to resolve and install only the missing sub-dependencies.
            # We use --no-deps on the main package again but explicitly install
            # its requirements via pip's dependency resolver on a dry-run parse.
            try:
                # pip install <pkg> --dry-run would be ideal but isn't available
                # on all pip versions. Instead, just try importing common deps
                # that are known to be needed by our optional groups.
                _KNOWN_TRANSITIVE_DEPS = ["requests", "tqdm", "pillow", "numpy"]
                missing_deps = []
                for dep in _KNOWN_TRANSITIVE_DEPS:
                    try:
                        __import__(dep.replace("-", "_"))
                    except ImportError:
                        missing_deps.append(dep)
                if missing_deps:
                    subprocess.run(
                        [sys.executable, "-m", "pip", "--disable-pip-version-check", "install", *index_args, *missing_deps],
                        check=False,
                        text=True,
                        capture_output=True,
                    )
            except Exception:
                pass  # best effort
            importlib.invalidate_caches()
            return True
        else:
            raise
    importlib.invalidate_caches()
    return False


def ensure_imports(module_names: Iterable[str]) -> DependencyInstallResult:
    packages = []
    for module_name in module_names:
        package_spec = IMPORT_TO_PACKAGE_HINT.get(module_name, module_name)
        locked_package = _lock_package_spec(package_spec)
        if _needs_install(module_name, package_spec) and locked_package not in packages:
            packages.append(locked_package)
    dll_locked = install_packages(packages)
    return DependencyInstallResult(
        installed_packages=tuple(packages),
        restart_recommended=bool(packages) or dll_locked,
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

    dll_locked = install_packages(packages_to_install)
    return DependencyInstallResult(
        installed_packages=tuple(packages_to_install),
        restart_recommended=bool(packages_to_install) or dll_locked,
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
