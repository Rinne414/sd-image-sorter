"""The optional UMAP layout of the style map: availability probe, fit
parameters, the fit itself (imports umap-learn lazily) and the on-disk layout
cache under ``state/style-map/``. StyleMapService owns the job queue and the
in-memory copies; this module has no service state.
Moved verbatim from style_map_service.py (S2b.1 split)."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import logging
import os
import sys
import time
import warnings
from pathlib import Path
from typing import Any, Dict, Optional

import numpy as np

from config import get_state_dir
from optional_dependencies import GROUP_IMPORTS
from services.style_map_math import (
    NEAR_DUPLICATE_COS,
    STYLE_MAP_ALGO_VERSION,
    STYLE_MAP_BLAS_THREADS,
    UNLOCATABLE_MAX_COMPONENT,
    blas_budget,
)

logger = logging.getLogger(__name__)

UMAP_N_NEIGHBORS = 15
UMAP_MIN_DIST = 0.1
UMAP_METRIC = "cosine"
# UMAP's input is the representatives' projection on this many principal
# axes. Measured (S2b, owner's 1,961 Kaloscope vectors): recall@10 0.377 vs
# 0.392 on all 2048 dims for a fit of 11.2 s vs 15.7 s; 38,850 synthetic
# representatives 35.1 s vs 48.0 s. 128 axes: 0.390 / 11.7 s.
UMAP_INPUT_DIM = 64
# A fixed seed gives the same map for the same data (umap then runs its
# optimisation single-threaded; the neighbour search still uses numba threads).
UMAP_RANDOM_STATE = 0
# Fewer representatives than this stay on PCA: UMAP needs more points than
# neighbours, and a map this small reads fine on the principal axes.
UMAP_MIN_POINTS = max(UMAP_N_NEIGHBORS + 2, 21)
UMAP_INSTALL_MODEL_ID = "style-map-umap"
UMAP_STATUSES = (
    "unavailable",
    "too_few_points",
    "not_started",
    "queued",
    "computing",
    "ready",
    "failed",
)
LAYOUT_CACHE_DIR = "style-map"
# Newest layouts kept on disk per (library, space); older ones are deleted.
LAYOUT_CACHE_KEEP_PER_MAP = 4
LAYOUT_CACHE_MAX_BYTES = 64 * 1024 * 1024


def _module_importable(name: str) -> bool:
    if name in sys.modules:
        return True
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def umap_available() -> bool:
    """Whether the whole ``umap`` install group can be imported; checked per
    call because Prepare can install it while the process runs. A half
    installed group (umap without llvmlite) must not read as ready: every
    fit would fail."""
    return all(_module_importable(name) for name in GROUP_IMPORTS["umap"])


def umap_params() -> Dict[str, Any]:
    """The fit parameters; part of every layout's cache key and metadata."""
    return {
        "n_neighbors": UMAP_N_NEIGHBORS,
        "min_dist": UMAP_MIN_DIST,
        "metric": UMAP_METRIC,
        "input_dim": UMAP_INPUT_DIM,
        "random_state": UMAP_RANDOM_STATE,
    }


def map_rules() -> Dict[str, Any]:
    """The rules that chose the representatives; also part of the layout key."""
    return {
        "algo_version": STYLE_MAP_ALGO_VERSION,
        "near_duplicate_cos": NEAR_DUPLICATE_COS,
        "unlocatable_max_component": UNLOCATABLE_MAX_COMPONENT,
    }


def fit_umap_layout(features: np.ndarray) -> np.ndarray:
    """3-D UMAP of ``features`` (rows), centred and scaled to [-1, 1].

    Imports umap-learn here: the import plus numba's JIT cost 15-20 s in a
    fresh process, which is why the service only calls this in the
    background. numba is capped at the map's thread budget like BLAS.
    """
    import numba
    import umap

    numba.set_num_threads(
        max(1, min(STYLE_MAP_BLAS_THREADS, int(numba.get_num_threads())))
    )
    x = np.ascontiguousarray(features, dtype=np.float32)
    with warnings.catch_warnings():
        # umap warns at every fit that a seed makes it single-threaded; the
        # seed is deliberate (same data, same map).
        warnings.filterwarnings("ignore", message="n_jobs value 1 overridden")
        reducer = umap.UMAP(
            n_components=3,
            n_neighbors=min(UMAP_N_NEIGHBORS, len(x) - 1),
            min_dist=UMAP_MIN_DIST,
            metric=UMAP_METRIC,
            random_state=UMAP_RANDOM_STATE,
        )
        with blas_budget():
            xyz = np.asarray(reducer.fit_transform(x), dtype=np.float32)
    if xyz.ndim != 2 or xyz.shape != (len(x), 3) or not np.all(np.isfinite(xyz)):
        raise RuntimeError(f"UMAP returned an unusable layout of shape {xyz.shape}")
    xyz = xyz - xyz.mean(axis=0)
    peak = float(np.abs(xyz).max()) or 1.0
    return (xyz / peak).astype(np.float32)


# ------------------------------------------------------------ disk cache
def layout_paths(layout_key: tuple) -> tuple[Path, Path]:
    name = hashlib.sha256(repr(layout_key).encode("utf-8")).hexdigest()
    directory = Path(get_state_dir()) / LAYOUT_CACHE_DIR
    return directory / f"{name}.npz", directory / f"{name}.json"


def store_layout(
    layout_key: tuple, rep_ids: np.ndarray, xyz: np.ndarray, elapsed: float
) -> None:
    """Write the layout (tmp then rename) with its metadata and prune the cache."""
    npz_path, meta_path = layout_paths(layout_key)
    npz_path.parent.mkdir(parents=True, exist_ok=True)
    meta = {
        "library_id": layout_key[0],
        "space": layout_key[1],
        "method": "umap",
        "model_version": layout_key[2],
        "member_hash": layout_key[3],
        "vector_version": list(layout_key[4]),
        "umap": umap_params(),
        "map": map_rules(),
        "points": int(len(rep_ids)),
        "elapsed_s": round(float(elapsed), 3),
        "created_at": time.time(),
    }
    # tmp + flush + fsync + rename: a power loss leaves either the old pair
    # or the new one, never a zero-byte or truncated file under the real name.
    tmp_npz = npz_path.with_name(npz_path.name + ".tmp")
    with open(tmp_npz, "wb") as handle:
        np.savez(handle, ids=np.asarray(rep_ids, dtype=np.int64), xyz=xyz)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp_npz, npz_path)
    tmp_meta = meta_path.with_name(meta_path.name + ".tmp")
    with open(tmp_meta, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(meta, indent=1))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp_meta, meta_path)
    prune_layout_cache(npz_path.parent, keep=npz_path)


def discard_layout(layout_key: tuple) -> None:
    """Delete a layout's pair (best effort); used for damaged or stale files."""
    for path in layout_paths(layout_key):
        _unlink_quietly(path)


def load_layout(
    layout_key: tuple,
) -> Optional[tuple[np.ndarray, np.ndarray, float]]:
    """(ids, xyz, elapsed_s) of a cached layout made with the current
    parameters, or None. Anything unreadable (a zero-byte or truncated npz
    after a power loss raises EOFError / BadZipFile, not just OSError) is
    logged, deleted and treated as absent: the map must keep answering."""
    npz_path, meta_path = layout_paths(layout_key)
    if not npz_path.is_file() or not meta_path.is_file():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        if meta.get("umap") != umap_params() or meta.get("map") != map_rules():
            return None
        # Our own handle: when np.load fails half-way (truncated zip) its
        # internal handle would stay open and Windows could not delete the file.
        with open(npz_path, "rb") as handle, np.load(handle) as archive:
            ids = np.asarray(archive["ids"], dtype=np.int64)
            xyz = np.asarray(archive["xyz"], dtype=np.float32)
        if xyz.shape != (len(ids), 3) or not np.all(np.isfinite(xyz)):
            raise ValueError(f"layout shape {xyz.shape} does not fit {len(ids)} ids")
        return ids, xyz, float(meta.get("elapsed_s") or 0.0)
    except Exception as exc:  # any damage: never let the cache break the map
        logger.warning(
            "Style map: dropping unreadable UMAP layout cache %s: %s", npz_path, exc
        )
        discard_layout(layout_key)
        return None


def _unlink_quietly(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError as exc:
        logger.warning("Style map: could not delete %s: %s", path, exc)


def prune_layout_cache(directory: Path, *, keep: Path) -> None:
    """Keep the newest layouts per (library, space) and the whole cache under
    its byte cap; leftovers of interrupted writes (``*.tmp``) and halves of a
    pair (an npz without its json, or the reverse) go too."""
    for leftover in directory.glob("*.tmp"):
        _unlink_quietly(leftover)
    for npz_only in directory.glob("*.npz"):
        if not npz_only.with_suffix(".json").is_file():
            _unlink_quietly(npz_only)
    records = []
    for meta_path in directory.glob("*.json"):
        npz_path = meta_path.with_suffix(".npz")
        if not npz_path.is_file():
            _unlink_quietly(meta_path)
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            size = meta_path.stat().st_size + (
                npz_path.stat().st_size if npz_path.exists() else 0
            )
        except (OSError, ValueError):
            continue
        records.append(
            (
                (meta.get("library_id"), meta.get("space")),
                float(meta.get("created_at") or 0.0),
                size,
                npz_path,
                meta_path,
            )
        )
    records.sort(key=lambda record: record[1], reverse=True)  # newest first
    seen: Dict[tuple, int] = {}
    total = 0
    for group, _created, size, npz_path, meta_path in records:
        seen[group] = seen.get(group, 0) + 1
        total += size
        over_map = seen[group] > LAYOUT_CACHE_KEEP_PER_MAP
        over_bytes = total > LAYOUT_CACHE_MAX_BYTES and npz_path != keep
        if not (over_map or over_bytes):
            continue
        total -= size
        for path in (npz_path, meta_path):
            try:
                path.unlink()
            except FileNotFoundError:
                pass
            except OSError as exc:
                logger.warning("Style map: could not delete %s: %s", path, exc)
