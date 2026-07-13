"""Session-path allowlist — the /api/dataset/local-thumbnail security gate.

Moved from services/dataset_session_service.py (decomposition 2026-07,
claude-dsession-pins-REPORT.md §4). _session_path_cache is the pinned
in-place CONTAINER (never rebound anywhere — report §2): this module owns the
one dict object, the facade re-exports the SAME object, and readers
(tests/test_dataset_session_service.py:439 calls _session_path_cache.clear())
mutate it in place. _session_path_lock travels with it.

Bodies are VERBATIM except three seam lines:
  * _register_session_paths reads _SESSION_PATH_CACHE_MAX through _svc()
    (twice) — the pin suite patches it on the facade module object.
  * register_scan_manifest_paths_for_session resolves
    iter_scan_manifest_paths through _svc() — a module-level import of
    manifest_store here would be a load cycle (manifest_store imports
    _register_session_paths from this module), and the call-time facade
    lookup preserves the monolith's patch-visible module-global read.

SECURITY (pinned): only scan/upload/manifest-iteration code paths call
_register_session_paths; resolve_paths_for_dataset must NOT grant membership.
"""
from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List

from PIL import Image

from services.dataset_session.ids_and_items import _ds_id_for_path
from utils.path_validation import normalize_user_path


def _svc():
    """Resolve facade-patched seams through services.dataset_session_service at call time.

    The pin suite patches ``_SESSION_PATH_CACHE_MAX`` on the facade module
    object (claude-dsession-pins-REPORT.md §3b), and
    ``iter_scan_manifest_paths`` must resolve through the facade at call time
    (a module-level import here would cycle with manifest_store). The lazy
    import avoids a facade<->submodule load cycle.
    """
    import services.dataset_session_service as dataset_session_service

    return dataset_session_service

# ------------------------------ session path allowlist ------------------------------

# How long an in-memory "this path was served by a Dataset Maker session"
# entry stays trusted. Long enough for a long export/audit pass, short
# enough that a stale process cannot be used to read arbitrary files
# hours after the user walked away.
_SESSION_PATH_TTL_SECONDS = 6 * 60 * 60  # 6 hours

# Bounded LRU of (abs_path_str -> expiry_timestamp). A path is only
# resolvable by the local-thumbnail endpoint if it appears here AND the
# expiry has not passed. Entries are added by scan_folder_for_dataset,
# upload_files_for_dataset, and iter_scan_manifest_entries — i.e. every
# path the backend itself chose to surface to the client. The cap is
# generous (a 100k-image manifest) but bounded so a malicious or buggy
# client cannot grow this without limit.
_SESSION_PATH_CACHE_MAX = 200_000
_session_path_cache: "Dict[str, float]" = {}
_session_path_lock = threading.Lock()


def _normalize_session_path(raw: str) -> str:
    """Canonical key for the session path cache.

    Uses ``resolve(strict=False)`` so a path that has since been moved
    (e.g. after a `move` export) still matches its old cache entry. We
    intentionally do NOT require existence here; existence is checked
    by the caller before serving bytes.
    """
    try:
        return str(Path(normalize_user_path(str(raw))).resolve(strict=False))
    except (OSError, ValueError):
        return str(raw or "").strip()


def _register_session_paths(abs_paths: Iterable[str]) -> None:
    """Trust the given absolute paths for the local-thumbnail endpoint.

    Called by scan/upload/manifest iteration — i.e. only by code paths
    that have already validated the path is a real image under a folder
    the user explicitly chose. This is the allowlist that closes the
    arbitrary-host-file read hole on ``/api/dataset/local-thumbnail``.
    """
    expiry = time.monotonic() + _SESSION_PATH_TTL_SECONDS
    cleaned: List[str] = []
    for raw in abs_paths or []:
        key = _normalize_session_path(str(raw))
        if key:
            cleaned.append(key)
    if not cleaned:
        return
    with _session_path_lock:
        cache = _session_path_cache
        for key in cleaned:
            cache[key] = expiry
        # Bounded LRU eviction by insertion order when over capacity.
        if len(cache) > _svc()._SESSION_PATH_CACHE_MAX:
            overflow = len(cache) - _svc()._SESSION_PATH_CACHE_MAX
            # Drop the oldest entries (lowest expiry, not insertion order,
            # so an active long export keeps its paths even if many were
            # registered before it).
            for key in sorted(cache, key=cache.get)[:overflow]:
                cache.pop(key, None)


def is_path_in_dataset_session(raw_path: str) -> bool:
    """Return True if ``raw_path`` was surfaced by an active Dataset Maker session.

    This is the gate the local-thumbnail endpoint uses: a path is only
    readable as a thumbnail if the backend itself put it in front of
    the client via folder-scan, upload-files, or a scan-token manifest.
    That closes the hole where ``?path=<anywhere>`` could read arbitrary
    image bytes off the host.
    """
    key = _normalize_session_path(str(raw_path or ""))
    if not key:
        return False
    now = time.monotonic()
    with _session_path_lock:
        expiry = _session_path_cache.get(key)
        if expiry is None:
            return False
        if expiry < now:
            _session_path_cache.pop(key, None)
            return False
        # Refresh on access so an active editing session keeps its paths.
        _session_path_cache[key] = now + _SESSION_PATH_TTL_SECONDS
    return True


def register_scan_manifest_paths_for_session(scan_token: str) -> int:
    """Trust every path in a scan-token manifest for the local-thumbnail endpoint.

    Called when a manifest is iterated for export/audit/preview. Returns
    the number of paths registered. Cheap to call repeatedly: the cache
    is a dict keyed by normalized path, so re-registration just refreshes
    the expiry.
    """
    try:
        paths = list(_svc().iter_scan_manifest_paths(scan_token))
    except ValueError:
        return 0
    _register_session_paths(paths)
    return len(paths)


def virtual_image_record_for_path(abs_path: str, *, read_dimensions: bool = True) -> Dict[str, Any]:
    """Return a dict shaped like a row from ``database.get_images_by_ids``
    so existing pipelines (export, audit) can consume it without
    branching on the source.

    The synthetic record has:
      - ``id``: 0 (sentinel; never stored)
      - ``path``: absolute path
      - ``filename``: basename
      - ``ai_caption``, ``rating``, ``prompt``, ``negative_prompt``: empty
      - ``width`` / ``height``: filled when readable, else None
    """
    p = Path(abs_path)
    record: Dict[str, Any] = {
        "id": 0,
        "path": str(p),
        "filename": p.name,
        "ai_caption": None,
        "rating": None,
        "prompt": None,
        "negative_prompt": None,
        "checkpoint": None,
        "metadata": None,
        "metadata_json": None,
        "loras": None,
        "model_hash": None,
        "width": None,
        "height": None,
        "ds_id": _ds_id_for_path(str(p)),
    }
    if read_dimensions:
        try:
            with Image.open(p) as img:
                record["width"], record["height"] = img.size
        except Exception:  # noqa: BLE001 - non-fatal here; export will still work
            pass
    return record


