"""
Disk service: report cache directory sizes and selectively clean safe caches.

Used by ``backend/routers/disk.py`` to surface "what is using disk space and
what can I delete" to the user. Strict whitelist + path-containment checks
keep the cleanup endpoint from ever touching user data, models, or DB.
"""
from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path
from typing import Any, Dict, List


logger = logging.getLogger(__name__)


# Keys that the user is allowed to ask the cleanup endpoint to wipe. Any
# key not in this set is rejected.
SAFE_TO_CLEAN_KEYS = ("tmp", "pip_cache", "thumbnails", "cache")


def _dir_size_bytes(path: Path) -> int:
    """Sum the size of every regular file under ``path``. Best-effort."""
    if not path.exists():
        return 0
    total = 0
    try:
        for entry in path.rglob("*"):
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
    from config import get_temp_dir, get_thumbnail_cache_dir, get_data_dir

    data_root = Path(get_data_dir()).resolve()
    return {
        "tmp": {
            "path": Path(get_temp_dir()).resolve(),
            "label_key": "disk.tmp",
        },
        "pip_cache": {
            "path": Path(os.environ.get("PIP_CACHE_DIR") or (data_root / "pip-cache")).resolve(),
            "label_key": "disk.pipCache",
        },
        "thumbnails": {
            "path": Path(get_thumbnail_cache_dir()).resolve(),
            "label_key": "disk.thumbnails",
        },
        "cache": {
            "path": Path(os.environ.get("SD_IMAGE_SORTER_CACHE_DIR") or (data_root / "cache")).resolve(),
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

    return {
        "models": {"paths": model_dirs, "label_key": "disk.models"},
        "hf_cache": {"paths": [Path(hf_home)], "label_key": "disk.hfCache"},
        "torch_runtime": {"paths": [Path(torch_home)], "label_key": "disk.torchRuntime"},
        "favorites": {"paths": [Path(favorites)], "label_key": "disk.favorites"},
        "config": {"paths": [Path(config_dir)], "label_key": "disk.config"},
    }


def get_cache_status() -> Dict[str, Any]:
    """Report sizes for both safe-to-clean and preserved directories."""
    safe_to_clean: List[Dict[str, Any]] = []
    for key, info in _safe_to_clean_paths().items():
        path: Path = info["path"]
        safe_to_clean.append({
            "key": key,
            "label_key": info["label_key"],
            "path": str(path),
            "size_bytes": _dir_size_bytes(path),
            "exists": path.exists(),
        })

    preserved: List[Dict[str, Any]] = []
    for key, info in _preserved_paths().items():
        total = sum(_dir_size_bytes(p) for p in info["paths"])
        preserved.append({
            "key": key,
            "label_key": info["label_key"],
            "size_bytes": total,
        })

    return {"safe_to_clean": safe_to_clean, "preserved": preserved}


def clean_caches(keys: List[str]) -> Dict[str, Any]:
    """Wipe the contents of whitelisted cache directories.

    Safety checks:
      1. Key must be in ``SAFE_TO_CLEAN_KEYS``.
      2. Resolved path must not equal the data root.
      3. Resolved path must be inside the data root, except for ``pip_cache``
         which we allow to point elsewhere because PIP_CACHE_DIR may be a
         user-set system path.
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
        try:
            resolved = target.resolve()
        except OSError as exc:
            errors.append({"key": key, "error": f"Could not resolve path: {exc}"})
            continue

        if resolved == data_root:
            errors.append({"key": key, "error": "Refusing to delete the data root"})
            continue

        if data_root not in resolved.parents and key != "pip_cache":
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
