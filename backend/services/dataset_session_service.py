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
import logging
import os
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from PIL import Image, UnidentifiedImageError

from config import ALLOWED_IMAGE_EXTENSIONS
from utils.path_validation import normalize_user_path, validate_folder_path


logger = logging.getLogger(__name__)


# Cap each scan to keep the response payload bounded (a 50k-folder scan
# at ~3 KB per thumbnail base64 would be ~150 MB which the frontend
# can't render anyway). The frontend can re-call with ``recursive=False``
# on subfolders if it needs more.
MAX_SCAN_RESULTS = 5_000

# Thumbnail size for the frontend queue + audit panel.
THUMBNAIL_MAX_PX = 256


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
            img.save(buf, format="JPEG", quality=80, optimize=True)
            thumb_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            return width, height, thumb_b64
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        logger.warning("dataset-session: failed to read %s: %s", path, exc)
        return None


def scan_folder_for_dataset(
    folder_path: str,
    *,
    recursive: bool = False,
    limit: int = MAX_SCAN_RESULTS,
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
    normalized = normalize_user_path(folder_path)
    is_valid, error = validate_folder_path(normalized, allow_create=False)
    if not is_valid:
        raise ValueError(error or "Invalid folder path")

    base = Path(normalized).resolve()
    iterator: Iterable[Path]
    if recursive:
        iterator = (p for p in base.rglob("*") if p.is_file())
    else:
        iterator = (p for p in base.iterdir() if p.is_file())

    items: List[Dict[str, Any]] = []
    total_seen = 0
    skipped = 0
    truncated = False

    for path in iterator:
        if not _is_image_path(path):
            continue
        total_seen += 1
        if len(items) >= int(max(1, limit)):
            truncated = True
            break

        try:
            stat = path.stat()
        except OSError as exc:
            logger.warning("dataset-session: stat failed for %s: %s", path, exc)
            skipped += 1
            continue

        meta = _read_image_metadata(path)
        if meta is None:
            skipped += 1
            continue

        width, height, thumb_b64 = meta
        abs_path = str(path.resolve())
        items.append({
            "ds_id": _ds_id_for_path(abs_path),
            "abs_path": abs_path,
            "filename": path.name,
            "width": width,
            "height": height,
            "mtime": stat.st_mtime,
            "size": stat.st_size,
            "thumb_b64": thumb_b64,
        })

    items.sort(key=lambda item: item["filename"].lower())

    return {
        "folder_path": str(base),
        "items": items,
        "total_files_seen": total_seen,
        "skipped_unreadable": skipped,
        "truncated": truncated,
    }


def resolve_paths_for_dataset(paths: Iterable[str]) -> List[str]:
    """Validate + normalise a list of image paths supplied by the client.

    Returns the absolute paths in the original order. Skips silently:
      - paths that don't exist
      - paths that resolve to a directory (the client should not send those)
      - paths whose extension isn't a recognised image type

    Does NOT enforce ``allowed_base`` because the dataset session is
    deliberately allowed to span arbitrary user folders. Path-traversal
    safety still comes from ``normalize_user_path`` + ``Path.resolve``.
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


def virtual_image_record_for_path(abs_path: str) -> Dict[str, Any]:
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
    if _UPLOAD_DIR is None or not _UPLOAD_DIR.exists():
        # Use data/dataset-uploads so it lives alongside other runtime data
        from pathlib import Path as _P
        data_dir = _P(__file__).resolve().parent.parent / "data" / "dataset-uploads"
        data_dir.mkdir(parents=True, exist_ok=True)
        _UPLOAD_DIR = data_dir
    return _UPLOAD_DIR


async def upload_files_for_dataset(files) -> Dict[str, Any]:
    """Save uploaded files to a temp directory and return scan-like items.

    Accepts a list of FastAPI UploadFile objects. Returns the same shape
    as scan_folder_for_dataset so the frontend can use addLocalItems().
    """
    upload_dir = _get_upload_dir()
    items: List[Dict[str, Any]] = []
    skipped = 0

    for upload_file in files:
        filename = upload_file.filename or "unknown.png"
        ext = Path(filename).suffix.lower()
        if ext not in ALLOWED_IMAGE_EXTENSIONS:
            skipped += 1
            continue

        # Write to disk with a unique name to avoid collisions
        dest = upload_dir / filename
        counter = 1
        while dest.exists():
            stem = Path(filename).stem
            dest = upload_dir / f"{stem}_{counter}{ext}"
            counter += 1

        content = await upload_file.read()
        dest.write_bytes(content)

        abs_path = str(dest.resolve())
        meta = _read_image_metadata(dest)
        if meta is None:
            skipped += 1
            dest.unlink(missing_ok=True)
            continue

        width, height, thumb_b64 = meta
        stat = dest.stat()
        items.append({
            "ds_id": _ds_id_for_path(abs_path),
            "abs_path": abs_path,
            "filename": dest.name,
            "width": width,
            "height": height,
            "mtime": stat.st_mtime,
            "size": stat.st_size,
            "thumb_b64": thumb_b64,
        })

    if not items:
        raise ValueError("No valid image files in the upload.")

    return {"items": items, "skipped_unreadable": skipped}
