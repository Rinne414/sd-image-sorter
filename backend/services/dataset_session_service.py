"""Dataset Session service — the "small gallery" workspace.

Implements the v3.2.2 vision from issue #5 point 5: a Dataset Maker that
can pull images from the main library OR scan a folder directly without
adding rows to the main ``images.db``.

Goals
-----
1. Folder import: ``scan_folder_for_dataset(folder_path, recursive)``
   returns a list of session items with thumbnail+metadata, derived
   purely from on-disk inspection. No DB writes. Each item carries a
   stable ``ds_id`` (``ds:<sha1(abspath)[:16]>``) the frontend can use
   to reference the local item across requests.
2. Path resolution: ``resolve_paths(paths)`` validates a list of file
   paths against ``ALLOWED_IMAGE_EXTENSIONS`` and returns absolute
   normalised paths the rest of the dataset pipeline can consume.

What this module is NOT
-----------------------
* It does not own a database table — the dataset session lives entirely
  in the client. The backend just answers "scan this folder" and
  "write a sidecar at this path" requests.
* It does not load AI models. Smart Tag / aesthetic / similarity reach
  into ``oppai_oracle_tagger`` / ``aesthetic`` / ``similarity`` directly
  the same way they do for DB-backed images; the only difference is
  that the caller passes a path string rather than an image_id.

Design rationale
----------------
A "real" small gallery would need a ``dataset_session`` SQL table and
session-scoped IDs; that's a significant migration. For v3.2.2 we keep
the data path-only so:

* The big-library invariant ("scanning a folder always adds to the
  main DB") is preserved exactly — the new flow just doesn't use it.
* Captions for local items live in the frontend ``localStorage`` keyed
  by absolute path, so they survive page reloads but are decoupled
  from the DB.
* If the user later wants to promote local items to the main library,
  they can run the regular ``/api/scan`` over the same folder.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
import os
import re
import shutil
import threading
import time
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from itertools import islice
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Iterable, Iterator, List, Optional, Tuple

from PIL import Image, UnidentifiedImageError

from config import ALLOWED_IMAGE_EXTENSIONS
from utils.path_validation import normalize_user_path, validate_folder_path


logger = logging.getLogger(__name__)


# Cap each folder-scan preview page to keep thumbnail payloads bounded.
# This is a page size, not a dataset-size cap: large folder scans still
# return a lightweight manifest so "apply to all" operations include images
# whose thumbnails have not been loaded yet.
MAX_SCAN_RESULTS = 5_000

# Thumbnail size for the frontend queue + editor. These are embedded directly
# in folder-scan JSON responses, so keep them small enough for 5k preview pages.
THUMBNAIL_MAX_PX = 256
THUMBNAIL_JPEG_QUALITY = 70
SCAN_THUMB_WORKERS = max(4, min(16, (os.cpu_count() or 4)))

_SCAN_TOKEN_RE = re.compile(r"^[a-f0-9]{32}$")
_SCAN_DIR: Optional[Path] = None

# Scan-token manifests under data/dataset-scans/ used to accumulate
# forever — every folder-scan wrote a new NDJSON file and nothing ever
# removed it. This TTL cap (in seconds) is enforced by
# ``purge_expired_scan_manifests`` which runs on app startup and after
# each successful folder-scan. Old tokens are safe to delete: the
# frontend re-issues a fresh scan when an expired token is referenced.
SCAN_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60  # 7 days

# Decompression-bomb guard for uploaded ZIP/RAR archives.
#
# These are a malware / zip-bomb safeguard, NOT a dataset-size limit: the
# values mirror update_service's bounded-extraction caps
# (_MAX_UPDATE_ARCHIVE_ENTRIES / _MAX_UPDATE_ARCHIVE_UNCOMPRESSED_BYTES) and
# are deliberately generous so they sit far above any legitimate LoRA dataset
# (20k images, 2 GiB uncompressed). A real training set never trips them; a
# crafted bomb that inflates a tiny archive into terabytes does.
_MAX_ARCHIVE_ENTRIES = 20000
_MAX_ARCHIVE_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024


def _ds_id_for_path(abs_path: str) -> str:
    """Stable session id derived from the absolute file path.

    Using the path (rather than a counter) means refreshing the page or
    re-scanning the same folder produces the same ``ds_id``s, which lets
    captions stored in ``localStorage`` survive reloads.
    """
    digest = hashlib.sha1(str(abs_path).encode("utf-8", errors="replace")).hexdigest()
    return f"ds:{digest[:16]}"


def _is_image_path(path: Path) -> bool:
    return path.suffix.lower() in ALLOWED_IMAGE_EXTENSIONS


def _read_image_metadata(path: Path) -> Optional[Tuple[int, int, str]]:
    """Return ``(width, height, thumbnail_b64)`` for ``path`` or None on failure.

    The thumbnail is a 256-px-on-the-long-edge JPEG-encoded base64 string
    suitable for direct injection into an ``<img src="data:image/jpeg;base64,...">``
    tag. We use JPEG instead of WEBP to maximise browser compatibility
    (Safari + older Firefox) and quality 80 to keep payload modest.
    """
    try:
        with Image.open(path) as img:
            img = img.convert("RGB") if img.mode not in ("RGB", "L") else img
            width, height = img.size
            # Make a thumbnail in-place; PIL preserves aspect ratio.
            img.thumbnail((THUMBNAIL_MAX_PX, THUMBNAIL_MAX_PX))
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=THUMBNAIL_JPEG_QUALITY)
            thumb_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            return width, height, thumb_b64
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        logger.warning("dataset-session: failed to read %s: %s", path, exc)
        return None


def _get_scan_dir() -> Path:
    """Return the temp manifest directory used for large folder scans."""
    global _SCAN_DIR
    if _SCAN_DIR is None or not _SCAN_DIR.exists():
        data_dir = Path(__file__).resolve().parent.parent / "data" / "dataset-scans"
        data_dir.mkdir(parents=True, exist_ok=True)
        _SCAN_DIR = data_dir
    return _SCAN_DIR


def _scan_manifest_path(scan_token: str) -> Path:
    token = str(scan_token or "")
    if not _SCAN_TOKEN_RE.fullmatch(token):
        raise ValueError("Invalid folder scan token")
    return _get_scan_dir() / f"{token}.json"


def purge_expired_scan_manifests(*, max_age_seconds: int = SCAN_TOKEN_TTL_SECONDS) -> int:
    """Delete scan-token manifests older than ``max_age_seconds``.

    Returns the number of token files removed. Safe to call repeatedly:
    only files matching ``<32-hex>.json`` / ``<32-hex>.paths.jsonl`` /
    ``<32-hex>.tmp`` under the scan dir are considered, so unrelated
    files in ``data/dataset-scans/`` are left alone.

    This closes the unbounded-growth hole where every folder-scan wrote
    a new NDJSON manifest and nothing ever removed them — long-running
    installs accumulated thousands of stale manifest files.
    """
    import time as _time

    scan_dir = _get_scan_dir()
    cutoff = _time.time() - int(max_age_seconds)
    removed = 0
    token_pattern = re.compile(r"^([a-f0-9]{32})(?:\.paths\.jsonl|\.json|\.tmp)$")
    try:
        for entry in os.scandir(scan_dir):
            if not entry.is_file():
                continue
            match = token_pattern.fullmatch(entry.name)
            if not match:
                continue
            try:
                mtime = entry.stat().st_mtime
            except OSError:
                continue
            if mtime < cutoff:
                try:
                    os.unlink(entry.path)
                    removed += 1
                except OSError:
                    # Best-effort: a locked/in-use manifest is left for
                    # the next sweep rather than crashing the caller.
                    continue
    except OSError:
        return removed
    return removed


def _scan_manifest_paths_path(scan_token: str) -> Path:
    token = str(scan_token or "")
    if not _SCAN_TOKEN_RE.fullmatch(token):
        raise ValueError("Invalid folder scan token")
    return _get_scan_dir() / f"{token}.paths.jsonl"


def _iter_folder_image_entries(base: Path, recursive: bool) -> Iterator[Dict[str, Any]]:
    """Yield lightweight image entries using ``os.scandir``.

    ``Path.rglob`` + per-file ``resolve`` is very slow on large Windows-mounted
    folders under WSL. Dataset Maker only needs stable absolute paths for the
    initial manifest; dimensions/thumbnails are hydrated later when visible.
    """
    stack = [os.fspath(base)]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    try:
                        if recursive and entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                            continue
                        if not entry.is_file(follow_symlinks=True):
                            continue
                    except OSError:
                        continue
                    if os.path.splitext(entry.name)[1].lower() not in ALLOWED_IMAGE_EXTENSIONS:
                        continue
                    yield {
                        "path": os.path.abspath(entry.path),
                        "filename": entry.name,
                    }
        except OSError as exc:
            logger.debug("dataset-session: cannot scan %s: %s", current, exc)


def _build_scan_manifest(base: Path, recursive: bool) -> Tuple[str, Dict[str, Any]]:
    """Walk a folder once and cache image paths for later pages.

    Metadata and base64 thumbnails are intentionally generated page-by-page so
    a 100k-image folder does not produce a huge JSON response or DOM payload.
    The path manifest is NDJSON, not a JSON array, so a 1M-image folder can be
    paged and consumed by backend jobs without materialising every path in
    Python memory.
    """
    token = uuid.uuid4().hex
    meta_path = _scan_manifest_path(token)
    paths_path = _scan_manifest_paths_path(token)
    tmp_meta = meta_path.with_suffix(".tmp")
    tmp_paths = paths_path.with_suffix(".tmp")
    total = 0
    try:
        with tmp_paths.open("w", encoding="utf-8", newline="\n") as handle:
            for entry in _iter_folder_image_entries(base, recursive):
                handle.write(json.dumps(entry, ensure_ascii=False))
                handle.write("\n")
                total += 1
        tmp_paths.replace(paths_path)
    except Exception:
        tmp_paths.unlink(missing_ok=True)
        paths_path.unlink(missing_ok=True)
        raise

    manifest = {
        "folder_path": str(base),
        "recursive": bool(recursive),
        "paths_file": paths_path.name,
        "manifest_format": "jsonl-items-v2",
        "total_files_seen": total,
    }
    try:
        tmp_meta.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        tmp_meta.replace(meta_path)
    except Exception:
        tmp_meta.unlink(missing_ok=True)
        paths_path.unlink(missing_ok=True)
        raise
    return token, manifest


def _load_scan_manifest(scan_token: str) -> Dict[str, Any]:
    path = _scan_manifest_path(scan_token)
    if not path.exists():
        raise ValueError("Folder scan token expired. Scan the folder again.")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError("Folder scan token is corrupt. Scan the folder again.") from exc
    if not isinstance(data, dict):
        raise ValueError("Folder scan token is invalid. Scan the folder again.")
    if isinstance(data.get("paths"), list):
        return data
    paths_file = data.get("paths_file")
    if not isinstance(paths_file, str) or not paths_file:
        raise ValueError("Folder scan token is invalid. Scan the folder again.")
    paths_path = _get_scan_dir() / Path(paths_file).name
    if not paths_path.exists():
        raise ValueError("Folder scan token path manifest expired. Scan the folder again.")
    return data


def iter_scan_manifest_paths(scan_token: str) -> Iterator[str]:
    """Yield cached folder-scan paths without loading the whole manifest.

    Old JSON-array manifests are still supported for compatibility with jobs
    started before this change, but new scans use a streaming NDJSON path file.
    """
    manifest = _load_scan_manifest(scan_token)
    legacy_paths = manifest.get("paths")
    if isinstance(legacy_paths, list):
        for path in legacy_paths:
            value = str(path or "").strip()
            if value:
                yield value
        return

    for entry in iter_scan_manifest_entries(scan_token):
        value = str(entry.get("path") or "").strip()
        if value:
            yield value


def iter_scan_manifest_entries(scan_token: str) -> Iterator[Dict[str, Any]]:
    """Yield cached folder-scan entries without loading the whole manifest.

    Each yielded entry's ``path`` is registered with the Dataset Maker
    session path allowlist so the local-thumbnail endpoint can later
    serve it. This is the security boundary that stops
    ``/api/dataset/local-thumbnail?path=<anywhere>`` from reading
    arbitrary host files: only paths the backend itself surfaced here
    become thumbnail-readable.
    """
    manifest = _load_scan_manifest(scan_token)
    legacy_paths = manifest.get("paths")
    if isinstance(legacy_paths, list):
        registered: List[str] = []
        for index, path in enumerate(legacy_paths):
            value = str(path or "").strip()
            if value:
                p = Path(value)
                registered.append(value)
                yield {
                    "path": value,
                    "filename": p.name,
                    "scan_index": index,
                    "size": 0,
                    "mtime": 0.0,
                }
        _register_session_paths(registered)
        return

    paths_file = str(manifest.get("paths_file") or "")
    paths_path = _get_scan_dir() / Path(paths_file).name
    registered: List[str] = []
    try:
        with paths_path.open("r", encoding="utf-8") as handle:
            for index, line in enumerate(handle):
                raw = line.strip()
                if not raw:
                    continue
                try:
                    value = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if isinstance(value, dict):
                    path = str(value.get("path") or "").strip()
                    if not path:
                        continue
                    registered.append(path)
                    yield {
                        "path": path,
                        "filename": str(value.get("filename") or Path(path).name),
                        "scan_index": int(value.get("scan_index", index) or index),
                        "size": int(value.get("size", 0) or 0),
                        "mtime": float(value.get("mtime", 0.0) or 0.0),
                    }
                    continue
                path = str(value or "").strip()
                if path:
                    registered.append(path)
                    yield {
                        "path": path,
                        "filename": Path(path).name,
                        "scan_index": index,
                        "size": 0,
                        "mtime": 0.0,
                    }
        _register_session_paths(registered)
    except OSError as exc:
        raise ValueError("Folder scan token path manifest is unreadable. Scan the folder again.") from exc


def get_scan_manifest_paths(scan_token: str) -> List[str]:
    """Return cached folder-scan paths for compatibility tests/small callers.

    Large jobs should use ``iter_scan_manifest_paths`` so they do not hold a
    100k-1M path manifest in memory.
    """
    return list(iter_scan_manifest_paths(scan_token))


def count_scan_manifest_paths(scan_token: str, exclude_paths: Optional[Iterable[str]] = None) -> int:
    exclude_set = {str(path) for path in (exclude_paths or []) if path}
    if not exclude_set:
        manifest = _load_scan_manifest(scan_token)
        if "total_files_seen" in manifest:
            return int(manifest.get("total_files_seen") or 0)
    return sum(1 for path in iter_scan_manifest_paths(scan_token) if str(path) not in exclude_set)


def _manifest_item_for_path(path: Any, index: int) -> Dict[str, Any]:
    """Return path-only item data for full-session membership.

    This intentionally avoids opening the image. It lets a 100k-image folder
    become 100k logical Dataset Maker items while thumbnails/dimensions are
    hydrated page-by-page.
    """
    if isinstance(path, dict):
        abs_path = str(path.get("path") or "").strip()
        filename = str(path.get("filename") or Path(abs_path).name)
        stat_size = int(path.get("size", 0) or 0)
        stat_mtime = float(path.get("mtime", 0.0) or 0.0)
    else:
        abs_path = str(path or "").strip()
        filename = Path(abs_path).name
        stat_size = 0
        stat_mtime = 0.0
    return {
        "ds_id": _ds_id_for_path(abs_path),
        "abs_path": abs_path,
        "filename": filename,
        "width": 0,
        "height": 0,
        "mtime": stat_mtime,
        "size": stat_size,
        "thumb_b64": "",
        "scan_index": index,
        "source_kind": "folder_path",
        "sidecar_capability": "beside_image",
    }


def _session_item_for_path(path: Path, scan_index: Optional[int] = None) -> Optional[Dict[str, Any]]:
    try:
        stat = path.stat()
    except OSError as exc:
        logger.warning("dataset-session: stat failed for %s: %s", path, exc)
        return None

    meta = _read_image_metadata(path)
    if meta is None:
        return None

    width, height, thumb_b64 = meta
    abs_path = str(path.resolve())
    return {
        "ds_id": _ds_id_for_path(abs_path),
        "abs_path": abs_path,
        "filename": path.name,
        "width": width,
        "height": height,
        "mtime": stat.st_mtime,
        "size": stat.st_size,
        "thumb_b64": thumb_b64,
        "scan_index": scan_index,
        "source_kind": "folder_path",
        "sidecar_capability": "beside_image",
    }


def _session_item_for_indexed_path(indexed_path: Tuple[int, str]) -> Optional[Dict[str, Any]]:
    scan_index, raw_path = indexed_path
    return _session_item_for_path(Path(raw_path), scan_index=scan_index)


def _session_items_for_page_paths(page_paths: List[str], *, start_index: int) -> Tuple[List[Dict[str, Any]], int]:
    indexed = [(start_index + idx, raw_path) for idx, raw_path in enumerate(page_paths)]
    if len(indexed) <= 1:
        items = []
        skipped = 0
        for entry in indexed:
            item = _session_item_for_indexed_path(entry)
            if item is None:
                skipped += 1
            else:
                items.append(item)
        return items, skipped

    workers = min(SCAN_THUMB_WORKERS, len(indexed))
    items: List[Dict[str, Any]] = []
    skipped = 0
    with ThreadPoolExecutor(max_workers=workers) as executor:
        for item in executor.map(_session_item_for_indexed_path, indexed):
            if item is None:
                skipped += 1
            else:
                items.append(item)
    return items, skipped


def scan_folder_for_dataset(
    folder_path: str,
    *,
    recursive: bool = False,
    limit: int = MAX_SCAN_RESULTS,
    offset: int = 0,
    scan_token: Optional[str] = None,
    include_thumbnails: bool = True,
) -> Dict[str, Any]:
    """Scan a folder for images and return session-ready metadata.

    Returns a dict with::

        {
            "folder_path": str,
            "items": [
                {
                    "ds_id": "ds:<sha1>",
                    "abs_path": str,
                    "filename": str,
                    "width": int,
                    "height": int,
                    "mtime": float,
                    "size": int,
                    "thumb_b64": str,  # 'data:image/jpeg;base64,...' WITHOUT the prefix
                },
                ...
            ],
            "total_files_seen": int,    # before the limit cap
            "skipped_unreadable": int,
            "truncated": bool,
        }

    Does NOT write anything to the main ``images.db``.
    """
    normalized_limit = max(1, min(int(limit or MAX_SCAN_RESULTS), int(MAX_SCAN_RESULTS)))
    normalized_offset = max(0, int(offset or 0))

    if scan_token:
        manifest = _load_scan_manifest(scan_token)
        token = str(scan_token)
        base = Path(str(manifest.get("folder_path") or folder_path or ".")).resolve()
        total_seen = int(manifest.get("total_files_seen") or 0)
    else:
        if not folder_path:
            raise ValueError("Folder path is required")
        normalized = normalize_user_path(folder_path)
        is_valid, error = validate_folder_path(normalized, allow_create=False)
        if not is_valid:
            raise ValueError(error or "Invalid folder path")
        base = Path(normalized).resolve()
        token, manifest = _build_scan_manifest(base, recursive)
        total_seen = int(manifest.get("total_files_seen") or 0)

    end_offset = min(total_seen, normalized_offset + normalized_limit)
    if include_thumbnails:
        page_paths = list(islice(iter_scan_manifest_paths(token), normalized_offset, normalized_offset + normalized_limit))
        items, skipped = _session_items_for_page_paths(page_paths, start_index=normalized_offset)
    else:
        page_entries = list(islice(iter_scan_manifest_entries(token), normalized_offset, normalized_offset + normalized_limit))
        items = [
            _manifest_item_for_path(entry, scan_index)
            for scan_index, entry in enumerate(page_entries, start=normalized_offset)
        ]
        skipped = 0

    has_more = end_offset < total_seen

    # Trust the paths we just surfaced so the local-thumbnail endpoint
    # can serve them. Without this gate the endpoint would be an
    # arbitrary-host-file read oracle.
    _register_session_paths(item.get("abs_path") for item in items if item.get("abs_path"))

    response = {
        "folder_path": str(base),
        "items": items,
        "total_files_seen": total_seen,
        "skipped_unreadable": skipped,
        "truncated": has_more,
        "scan_token": token,
        "offset": normalized_offset,
        "next_offset": end_offset if has_more else None,
        "has_more": has_more,
        "page_size": normalized_limit,
    }
    return response


def resolve_paths_for_dataset(paths: Iterable[str]) -> List[str]:
    """Validate + normalise a list of image paths supplied by the client.

    Returns the absolute paths in the original order. Skips silently:
      - paths that don't exist
      - paths that resolve to a directory (the client should not send those)
      - paths whose extension isn't a recognised image type

    Does NOT enforce ``allowed_base`` because the dataset session is
    deliberately allowed to span arbitrary user folders. Path-traversal
    safety still comes from ``normalize_user_path`` + ``Path.resolve``.

    NOTE: this helper is intentionally permissive. Callers that serve
    content to the browser (e.g. ``/api/dataset/local-thumbnail``) must
    additionally call :func:`is_path_in_dataset_session` so a client
    cannot turn the endpoint into an arbitrary-host-file read oracle.
    """
    out: List[str] = []
    seen: set = set()
    for raw in paths or []:
        if not raw:
            continue
        try:
            normalized = normalize_user_path(str(raw))
            resolved = Path(normalized).resolve()
        except (OSError, ValueError) as exc:
            logger.debug("dataset-session: cannot resolve %r: %s", raw, exc)
            continue
        if not resolved.exists() or not resolved.is_file():
            continue
        if resolved.suffix.lower() not in ALLOWED_IMAGE_EXTENSIONS:
            continue
        s = str(resolved)
        if s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


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
        if len(cache) > _SESSION_PATH_CACHE_MAX:
            overflow = len(cache) - _SESSION_PATH_CACHE_MAX
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
        paths = list(iter_scan_manifest_paths(scan_token))
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


# ------------------------------ upload-files ------------------------------

# Persistent upload directory so files survive the request lifecycle.
_UPLOAD_DIR: Optional[Path] = None


def _get_upload_dir() -> Path:
    """Return (and lazily create) a persistent temp directory for uploads."""
    global _UPLOAD_DIR
    if _UPLOAD_DIR is not None:
        _UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        return _UPLOAD_DIR
    if _UPLOAD_DIR is None or not _UPLOAD_DIR.exists():
        # Use data/dataset-uploads so it lives alongside other runtime data
        from pathlib import Path as _P
        data_dir = _P(__file__).resolve().parent.parent / "data" / "dataset-uploads"
        data_dir.mkdir(parents=True, exist_ok=True)
        _UPLOAD_DIR = data_dir
    return _UPLOAD_DIR


def _safe_uploaded_name(name: str, fallback: str = "image") -> str:
    """Return a filename safe to create under the upload directory."""
    leaf = Path(str(name or "")).name
    cleaned = "".join(ch if ch.isalnum() or ch in "._- " else "_" for ch in leaf).strip(" .")
    return cleaned or fallback


def _append_upload_item(dest: Path, items: List[Dict[str, Any]], *, source_kind: str) -> bool:
    """Read metadata for an uploaded/extracted image and append a session item.

    Items written here have a real on-disk path under the upload directory,
    so the export pipeline's ``beside_image`` mode can write a same-name
    ``.txt`` next to the extracted/uploaded copy. Earlier versions marked
    these as ``cache_only`` which forced the user into a separate output
    folder even though the image lives on disk.
    """
    meta = _read_image_metadata(dest)
    if meta is None:
        dest.unlink(missing_ok=True)
        return False

    width, height, thumb_b64 = meta
    stat = dest.stat()
    abs_path = str(dest.resolve())
    items.append({
        "ds_id": _ds_id_for_path(abs_path),
        "abs_path": abs_path,
        "filename": dest.name,
        "width": width,
        "height": height,
        "mtime": stat.st_mtime,
        "size": stat.st_size,
        "thumb_b64": thumb_b64,
        "source_kind": source_kind,
        "sidecar_capability": "beside_image",
    })
    return True


@dataclass
class _ArchiveExtractResult:
    skipped: int = 0


def _try_import_rarfile():
    """Soft-import the optional ``rarfile`` dependency.

    Returns the module on success or ``None`` if unavailable. We cannot
    rely on ``rarfile`` being installed because it requires the system
    ``unrar`` (or ``bsdtar`` / ``7z``) binary at runtime, and shipping
    those binaries on every platform is out of scope for this release.
    """
    try:
        import rarfile  # type: ignore
    except ImportError:
        return None
    return rarfile


async def _extract_rar_into_dataset(
    upload_file,
    upload_dir: Path,
    items: List[Dict[str, Any]],
) -> _ArchiveExtractResult:
    """Extract a RAR archive into ``upload_dir`` and append image items.

    Mirrors the ZIP extraction path:
    - Each archive lands in its own subdirectory under ``upload_dir``.
    - Path-traversal entries are skipped.
    - Non-image members are silently skipped.
    - Images that fail metadata read are counted as skipped.

    Raises ``ValueError`` when the ``rarfile`` dependency is missing or
    the system extractor binary cannot be found, with a message that
    points the user at the same workaround as before (extract manually
    or convert to ZIP).
    """
    rarfile = _try_import_rarfile()
    if rarfile is None:
        raise ValueError(
            "RAR archives need the optional 'rarfile' dependency and a system "
            "'unrar' binary. Install them, or extract the RAR to a folder / "
            "convert it to ZIP, then import again."
        )

    filename = upload_file.filename or "archive.rar"
    archive_dir = upload_dir / f"{_safe_uploaded_name(Path(filename).stem, 'archive')}_{uuid.uuid4().hex[:8]}"
    archive_dir.mkdir(parents=True, exist_ok=True)

    rar_buffer_path = archive_dir / f"_source_{uuid.uuid4().hex[:8]}.rar"
    try:
        if hasattr(upload_file, "file") and upload_file.file is not None:
            upload_file.file.seek(0)
            with rar_buffer_path.open("wb") as out:
                shutil.copyfileobj(upload_file.file, out, length=1024 * 1024)
        else:
            content = await upload_file.read()
            rar_buffer_path.write_bytes(content)

        skipped = 0
        try:
            with rarfile.RarFile(str(rar_buffer_path)) as rf:
                members = rf.infolist()
                if len(members) > _MAX_ARCHIVE_ENTRIES:
                    raise ValueError(
                        "RAR archive contains too many entries "
                        f"(> {_MAX_ARCHIVE_ENTRIES}); refusing to extract a "
                        "possible decompression bomb. / RAR 内含过多文件，已拒绝解压。"
                    )
                total_uncompressed_bytes = 0
                for member in members:
                    if member.isdir():
                        continue
                    total_uncompressed_bytes += int(getattr(member, "file_size", 0) or 0)
                    if total_uncompressed_bytes > _MAX_ARCHIVE_UNCOMPRESSED_BYTES:
                        raise ValueError(
                            "RAR archive uncompressed size exceeds the safe "
                            f"limit ({_MAX_ARCHIVE_UNCOMPRESSED_BYTES} bytes); "
                            "refusing to extract a possible decompression bomb. "
                            "/ RAR 解压后体积过大，已拒绝解压。"
                        )
                    raw_name = (member.filename or "").replace("\\", "/")
                    if not raw_name:
                        skipped += 1
                        continue
                    posix = PurePosixPath(raw_name)
                    if posix.is_absolute() or ".." in posix.parts:
                        skipped += 1
                        continue
                    suffix = Path(posix.name).suffix.lower()
                    if suffix not in ALLOWED_IMAGE_EXTENSIONS:
                        continue
                    safe_name = _safe_uploaded_name(posix.name, f"image{suffix or '.png'}")
                    dest = archive_dir / safe_name
                    counter = 1
                    while dest.exists():
                        dest = archive_dir / f"{Path(safe_name).stem}_{counter}{Path(safe_name).suffix}"
                        counter += 1
                    try:
                        with rf.open(member) as src, dest.open("wb") as out:
                            shutil.copyfileobj(src, out, length=1024 * 1024)
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("rar-extract: copy failed for %s: %s", raw_name, exc)
                        skipped += 1
                        continue
                    if not _append_upload_item(dest, items, source_kind="rar_extract"):
                        skipped += 1
        except ValueError:
            # Decompression-bomb guard (and multi-volume / path errors below)
            # must surface as a clear client error, not be swallowed by the
            # broad BadRarFile fallback when rarfile lacks a BadRarFile attr.
            raise
        except getattr(rarfile, "BadRarFile", Exception) as exc:  # noqa: BLE001
            logger.warning("rar-extract: bad archive %s: %s", filename, exc)
            skipped += 1
        except getattr(rarfile, "NeedFirstVolume", Exception):
            raise ValueError(
                "Multi-part RAR archives must be uploaded together starting from "
                "the first volume (.part1.rar). Extract the archive locally and "
                "import the folder instead."
            )
        except FileNotFoundError as exc:
            # rarfile raises this when the underlying unrar binary is missing.
            raise ValueError(
                "RAR extraction needs a system 'unrar' (or 'bsdtar') binary. "
                "Install it, extract the RAR to a folder, or convert it to ZIP."
            ) from exc
    finally:
        rar_buffer_path.unlink(missing_ok=True)

    return _ArchiveExtractResult(skipped=skipped)


async def upload_files_for_dataset(files, *, recursive: bool = True) -> Dict[str, Any]:
    """Save uploaded files to a temp directory and return scan-like items.

    Accepts a list of FastAPI UploadFile objects. Returns the same shape
    as scan_folder_for_dataset so the frontend can use addLocalItems().
    """
    upload_dir = _get_upload_dir()
    items: List[Dict[str, Any]] = []
    skipped = 0
    truncated = False

    for upload_file in files:
        filename = upload_file.filename or "unknown.png"
        ext = Path(filename).suffix.lower()

        if ext == ".rar":
            extracted = await _extract_rar_into_dataset(upload_file, upload_dir, items)
            skipped += extracted.skipped
            continue

        if ext == ".zip":
            archive_dir = upload_dir / f"{_safe_uploaded_name(Path(filename).stem, 'archive')}_{uuid.uuid4().hex[:8]}"
            archive_dir.mkdir(parents=True, exist_ok=True)
            try:
                if hasattr(upload_file, "file") and upload_file.file is not None:
                    upload_file.file.seek(0)
                    zip_source = upload_file.file
                else:
                    zip_source = io.BytesIO(await upload_file.read())

                with zipfile.ZipFile(zip_source) as zf:
                    members = zf.infolist()
                    if len(members) > _MAX_ARCHIVE_ENTRIES:
                        raise ValueError(
                            "ZIP archive contains too many entries "
                            f"(> {_MAX_ARCHIVE_ENTRIES}); refusing to extract a "
                            "possible decompression bomb. / ZIP 内含过多文件，已拒绝解压。"
                        )
                    total_uncompressed_bytes = 0
                    for member in members:
                        if member.is_dir():
                            continue
                        total_uncompressed_bytes += member.file_size
                        if total_uncompressed_bytes > _MAX_ARCHIVE_UNCOMPRESSED_BYTES:
                            raise ValueError(
                                "ZIP archive uncompressed size exceeds the safe "
                                f"limit ({_MAX_ARCHIVE_UNCOMPRESSED_BYTES} bytes); "
                                "refusing to extract a possible decompression bomb. "
                                "/ ZIP 解压后体积过大，已拒绝解压。"
                            )
                        raw_name = member.filename.replace("\\", "/")
                        posix = PurePosixPath(raw_name)
                        if posix.is_absolute() or ".." in posix.parts:
                            skipped += 1
                            continue
                        if not recursive and len(posix.parts) > 1:
                            continue
                        suffix = Path(posix.name).suffix.lower()
                        if suffix not in ALLOWED_IMAGE_EXTENSIONS:
                            continue
                        safe_name = _safe_uploaded_name(posix.name, f"image{suffix or '.png'}")
                        dest = archive_dir / safe_name
                        counter = 1
                        while dest.exists():
                            dest = archive_dir / f"{Path(safe_name).stem}_{counter}{Path(safe_name).suffix}"
                            counter += 1
                        with zf.open(member) as src, dest.open("wb") as out:
                            shutil.copyfileobj(src, out, length=1024 * 1024)
                        if not _append_upload_item(dest, items, source_kind="zip_extract"):
                            skipped += 1
            except zipfile.BadZipFile:
                skipped += 1
            continue

        if ext not in ALLOWED_IMAGE_EXTENSIONS:
            skipped += 1
            continue

        # Write to disk with a unique name to avoid collisions
        safe_filename = _safe_uploaded_name(filename, "image.png")
        dest = upload_dir / safe_filename
        counter = 1
        while dest.exists():
            stem = Path(safe_filename).stem
            dest = upload_dir / f"{stem}_{counter}{ext}"
            counter += 1

        if hasattr(upload_file, "file") and upload_file.file is not None:
            upload_file.file.seek(0)
            with dest.open("wb") as out:
                shutil.copyfileobj(upload_file.file, out, length=1024 * 1024)
        else:
            content = await upload_file.read()
            dest.write_bytes(content)

        if not _append_upload_item(dest, items, source_kind="uploaded_file"):
            skipped += 1

    if not items:
        raise ValueError("No valid image files in the upload.")

    # Trust the uploaded/extracted paths we just wrote to disk so the
    # local-thumbnail endpoint can serve them.
    _register_session_paths(item.get("abs_path") for item in items if item.get("abs_path"))

    return {"items": items, "skipped_unreadable": skipped, "truncated": truncated}
