"""
Disk service: report cache directory sizes and selectively clean safe caches.

Used by ``backend/routers/disk.py`` to surface "what is using disk space and
what can I delete" to the user. Strict whitelist + path-containment checks
keep the cleanup endpoint from ever touching user data, models, or DB.
"""
from __future__ import annotations

import logging
import json
import os
import shutil
import sys
import time
from pathlib import Path
from typing import Any, Dict, List


logger = logging.getLogger(__name__)


# Keys that the user is allowed to ask the cleanup endpoint to wipe. Any
# key not in this set is rejected.
SAFE_TO_CLEAN_KEYS = ("tmp", "pip_cache", "thumbnails", "cache")
VENV_REBUILD_MARKER_FILENAME = "rebuild-core-venv.json"


def _package_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _backend_venv_path() -> Path:
    return (_package_root() / "backend" / "venv").resolve()


def _portable_python_path() -> Path:
    return (_package_root() / "python").resolve()


def _is_current_python_portable() -> bool:
    try:
        Path(sys.executable).resolve().relative_to(_portable_python_path())
        return True
    except (OSError, ValueError):
        return False


def _runtime_environment_descriptor() -> Dict[str, Any]:
    if _is_current_python_portable():
        runtime_path = _portable_python_path()
        return {
            "kind": "portable",
            "path": runtime_path,
            "size_paths": [runtime_path / "Lib" / "site-packages", runtime_path / "Scripts"],
            "rebuild_target": "embedded_python_packages",
        }

    venv_path = _backend_venv_path()
    return {
        "kind": "venv",
        "path": venv_path,
        "size_paths": [venv_path],
        "rebuild_target": "backend_venv",
    }


def _venv_rebuild_marker_path() -> Path:
    from config import get_state_dir

    return Path(get_state_dir()) / VENV_REBUILD_MARKER_FILENAME


def _is_path_inside(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _dir_size_bytes_limited(path: Path, *, max_files: int = 5000, max_seconds: float = 0.15) -> tuple[int | None, bool]:
    """Best-effort directory size for potentially huge runtime/cache folders.

    venv/model/cache folders can contain tens of thousands of files on old full-AI
    installs. A full recursive size scan would make Feature Setup feel hung, so
    this helper returns ``(None, False)`` once the scan is too expensive.
    """
    if path.is_symlink():
        return 0, True
    if not path.exists():
        return 0, True
    total = 0
    scanned = 0
    deadline = time.monotonic() + max_seconds
    try:
        for entry in path.rglob("*"):
            if scanned >= max_files or time.monotonic() > deadline:
                return None, False
            scanned += 1
            if entry.is_symlink():
                continue
            if entry.is_file():
                try:
                    total += entry.stat().st_size
                except OSError:
                    pass
    except OSError as exc:
        logger.debug("Limited disk size scan failed under %s: %s", path, exc)
        return None, False
    return total, True


def _dir_size_bytes_limited_many(paths: List[Path]) -> tuple[int | None, bool]:
    total = 0
    complete = True
    for path in paths:
        size, path_complete = _dir_size_bytes_limited(path)
        if size is None:
            complete = False
        else:
            total += size
        complete = complete and path_complete
    return (total if complete else None, complete)


def get_runtime_environment_status() -> Dict[str, Any]:
    """Return local Python runtime state without recursively blocking on huge installs."""
    descriptor = _runtime_environment_descriptor()
    runtime_path: Path = descriptor["path"]
    marker_path = _venv_rebuild_marker_path()
    size_bytes, size_complete = _dir_size_bytes_limited_many(descriptor["size_paths"])
    backend_venv_path = _backend_venv_path()
    return {
        "runtime_kind": descriptor["kind"],
        "runtime_path": str(runtime_path),
        "runtime_rebuild_target": descriptor["rebuild_target"],
        "venv_path": str(backend_venv_path),
        "venv_exists": runtime_path.exists(),
        "venv_size_bytes": size_bytes,
        "venv_size_complete": size_complete,
        "rebuild_core_pending": marker_path.exists(),
        "rebuild_marker_path": str(marker_path),
    }


def request_core_runtime_rebuild() -> Dict[str, Any]:
    """Ask the next launcher run to rebuild the package-local Python runtime.

    The running backend cannot safely delete its own Python environment. Instead,
    Feature Setup writes a marker under data/state; run.bat/run.sh/run-portable.bat
    consume it before starting the backend again.
    """
    descriptor = _runtime_environment_descriptor()
    runtime_path: Path = descriptor["path"]
    package_root = _package_root()
    if descriptor["kind"] == "portable":
        if not _is_path_inside(runtime_path, package_root) or runtime_path.name != "python":
            raise RuntimeError(f"Refusing to schedule rebuild for unexpected portable Python path: {runtime_path}")
    else:
        if not _is_path_inside(runtime_path, package_root / "backend") or runtime_path.name != "venv":
            raise RuntimeError(f"Refusing to schedule rebuild for unexpected venv path: {runtime_path}")

    marker_path = _venv_rebuild_marker_path()
    marker_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "action": "rebuild_core_python_runtime",
        "runtime_kind": descriptor["kind"],
        "runtime_path": str(runtime_path),
        "rebuild_target": descriptor["rebuild_target"],
        "message": "Rebuild the package-local Python runtime on next launcher start and reinstall lightweight core dependencies.",
    }
    if descriptor["kind"] == "venv":
        payload["venv_path"] = str(runtime_path)
    marker_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return {
        "scheduled": True,
        "restart_required": True,
        "runtime_environment": get_runtime_environment_status(),
    }


def _dir_size_bytes(path: Path) -> int:
    """Sum the size of every regular file under ``path``. Best-effort."""
    if path.is_symlink():
        return 0
    if not path.exists():
        return 0
    total = 0
    try:
        for entry in path.rglob("*"):
            if entry.is_symlink():
                continue
            if entry.is_file():
                try:
                    total += entry.stat().st_size
                except OSError:
                    # Permission denied / file vanished mid-scan — skip silently.
                    pass
    except OSError as exc:
        logger.debug("Disk size scan failed under %s: %s", path, exc)
    return total


def _safe_to_clean_paths() -> Dict[str, Dict[str, Any]]:
    """Build the whitelist of cache directories the user can wipe."""
    from config import get_data_dir

    data_root = Path(get_data_dir()).resolve()
    return {
        "tmp": {
            "path": data_root / "tmp",
            "label_key": "disk.tmp",
        },
        "pip_cache": {
            # Only clean the app-owned pip cache. Do not trust PIP_CACHE_DIR
            # here: users or shells may point it at a global/home directory.
            "path": data_root / "pip-cache",
            "label_key": "disk.pipCache",
        },
        "thumbnails": {
            "path": data_root / "thumbnails",
            "label_key": "disk.thumbnails",
        },
        "cache": {
            "path": data_root / "cache",
            "label_key": "disk.cache",
        },
    }


def _preserved_paths() -> Dict[str, Dict[str, Any]]:
    """Directories the user must NOT delete via this UI (informational only)."""
    from config import (
        get_artist_model_dir,
        get_clip_model_dir,
        get_data_dir,
        get_nudenet_model_dir,
        get_sam3_model_dir,
        get_toriigate_model_dir,
        get_wd14_model_dir,
        get_yolo_model_dir,
        TEMP_DIR,
        THUMBNAIL_DIR,
        DEFAULT_CACHE_DIR,
    )

    data_root = Path(get_data_dir()).resolve()

    model_dirs: List[Path] = []
    for getter in (
        get_wd14_model_dir,
        get_yolo_model_dir,
        get_clip_model_dir,
        get_artist_model_dir,
        get_sam3_model_dir,
        get_nudenet_model_dir,
        get_toriigate_model_dir,
    ):
        try:
            model_dirs.append(Path(getter()))
        except Exception as exc:
            logger.debug("Model dir lookup failed: %s", exc)

    hf_home = os.environ.get("HF_HOME") or os.environ.get("TRANSFORMERS_CACHE") or str(data_root / "hf")
    torch_home = os.environ.get("TORCH_HOME") or str(data_root / "torch")
    favorites = os.environ.get("SD_IMAGE_SORTER_FAVORITES_PATH") or str(data_root / "favorites")
    config_dir = os.environ.get("SD_IMAGE_SORTER_CONFIG_DIR") or str(data_root / "config")

    external_runtime_paths: List[Path] = []
    for configured_path in (Path(TEMP_DIR), Path(THUMBNAIL_DIR), Path(DEFAULT_CACHE_DIR)):
        try:
            resolved = configured_path.expanduser().resolve()
        except OSError:
            resolved = configured_path.expanduser()
        if not _is_path_inside(resolved, data_root):
            external_runtime_paths.append(resolved)

    preserved = {
        "models": {"paths": model_dirs, "label_key": "disk.models"},
        "hf_cache": {"paths": [Path(hf_home)], "label_key": "disk.hfCache"},
        "torch_runtime": {"paths": [Path(torch_home)], "label_key": "disk.torchRuntime"},
        "favorites": {"paths": [Path(favorites)], "label_key": "disk.favorites"},
        "config": {"paths": [Path(config_dir)], "label_key": "disk.config"},
    }
    if external_runtime_paths:
        preserved["external_runtime_cache"] = {
            "paths": external_runtime_paths,
            "label_key": "disk.externalRuntimeCache",
        }
    return preserved


def get_cache_status() -> Dict[str, Any]:
    """Report sizes for both safe-to-clean and preserved directories."""
    safe_to_clean: List[Dict[str, Any]] = []
    for key, info in _safe_to_clean_paths().items():
        path: Path = info["path"]
        size, complete = _dir_size_bytes_limited(path)
        safe_to_clean.append({
            "key": key,
            "label_key": info["label_key"],
            "path": str(path),
            "size_bytes": size,
            "size_complete": complete,
            "exists": path.exists(),
        })

    preserved: List[Dict[str, Any]] = []
    for key, info in _preserved_paths().items():
        total = 0
        complete = True
        for path in info["paths"]:
            size, path_complete = _dir_size_bytes_limited(path)
            if size is None:
                complete = False
            else:
                total += size
            complete = complete and path_complete
        preserved.append({
            "key": key,
            "label_key": info["label_key"],
            "path": "; ".join(str(path) for path in info["paths"]),
            "size_bytes": total if complete else None,
            "size_complete": complete,
        })

    from config import get_thumbnail_cache_max_mb
    from thumbnail_cache import get_cache_stats as get_thumbnail_cache_stats

    thumbnail_cache = get_thumbnail_cache_stats()

    return {
        "safe_to_clean": safe_to_clean,
        "preserved": preserved,
        "settings": {"thumbnail_cache_max_mb": get_thumbnail_cache_max_mb()},
        "thumbnail_cache": thumbnail_cache,
        "runtime_environment": get_runtime_environment_status(),
    }


def update_cache_settings(*, thumbnail_cache_max_mb: int) -> Dict[str, Any]:
    """Persist cache-related settings and immediately apply safe limits."""
    from config import save_thumbnail_cache_max_mb
    from thumbnail_cache import enforce_cache_size_limit, get_cache_stats as get_thumbnail_cache_stats

    saved_limit = save_thumbnail_cache_max_mb(thumbnail_cache_max_mb)
    cleanup = enforce_cache_size_limit(force=True)
    return {
        "settings": {"thumbnail_cache_max_mb": saved_limit},
        "thumbnail_cache": get_thumbnail_cache_stats(),
        "limit_cleanup": cleanup,
    }


def clean_caches(keys: List[str]) -> Dict[str, Any]:
    """Wipe the contents of whitelisted cache directories.

    Safety checks:
      1. Key must be in ``SAFE_TO_CLEAN_KEYS``.
      2. Resolved path must not equal the data root.
      3. Resolved path must be inside the data root. ``pip_cache`` is also
         forced to the app-owned ``data/pip-cache`` path; external
         ``PIP_CACHE_DIR`` values are intentionally ignored for cleanup.
      4. We wipe directory CONTENTS but keep the directory itself so the
         app can keep writing without recreating it.
    """
    from config import get_data_dir

    data_root = Path(get_data_dir()).resolve()
    safe_paths = _safe_to_clean_paths()

    cleaned: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []

    for key in keys or []:
        if key not in safe_paths:
            errors.append({"key": key, "error": "Unknown cache key (not in whitelist)"})
            continue

        target = safe_paths[key]["path"]
        if target.is_symlink():
            errors.append({"key": key, "error": f"Refusing to clean symlinked cache directory: {target}"})
            continue
        try:
            resolved = target.resolve()
        except OSError as exc:
            errors.append({"key": key, "error": f"Could not resolve path: {exc}"})
            continue

        if resolved.is_symlink():
            errors.append({"key": key, "error": f"Refusing to clean symlinked cache directory: {resolved}"})
            continue

        if resolved == data_root:
            errors.append({"key": key, "error": "Refusing to delete the data root"})
            continue

        if data_root not in resolved.parents:
            errors.append({"key": key, "error": f"Path is outside data directory: {resolved}"})
            continue

        if not resolved.exists():
            cleaned.append({"key": key, "freed_bytes": 0})
            continue

        size_before = _dir_size_bytes(resolved)
        per_entry_errors: List[str] = []
        try:
            for entry in resolved.iterdir():
                try:
                    if entry.is_symlink() or entry.is_file():
                        entry.unlink()
                    elif entry.is_dir():
                        shutil.rmtree(entry, ignore_errors=False)
                except Exception as exc:
                    per_entry_errors.append(f"{entry.name}: {exc}")
        except OSError as exc:
            errors.append({"key": key, "error": f"Could not iterate {resolved}: {exc}"})
            continue

        size_after = _dir_size_bytes(resolved)
        freed = max(0, size_before - size_after)
        if per_entry_errors and freed == 0:
            errors.append({"key": key, "error": "; ".join(per_entry_errors[:3])})
        else:
            logger.info(
                "Cleaned cache key=%s path=%s freed=%d bytes (with %d entry errors)",
                key, resolved, freed, len(per_entry_errors),
            )
            entry_record: Dict[str, Any] = {"key": key, "freed_bytes": freed}
            if per_entry_errors:
                entry_record["partial_errors"] = per_entry_errors[:3]
            cleaned.append(entry_record)

    return {"cleaned": cleaned, "errors": errors}
