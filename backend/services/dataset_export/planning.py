"""Pure planning / path-safety helpers for the dataset export service.

Functions moved verbatim from services/dataset_export_service.py
(decomposition 2026-07, claude-dsexport-pins-REPORT.md §6) except the one
manifested line: _plan_single_rename resolves render_stem through _svc() at
call time because the pin suite patches it on the facade module object
(tests/test_dataset_export_pins.py monkeypatch.setattr(des, "render_stem",
...)); a bare re-import here would make that patch silently miss. NamingError
and resolve_collision are origin-imported (the same objects the facade
re-exports; no test patches them on the facade), so the except clause still
catches the class a patched facade render_stem raises. The ``database``
module singleton is patched on its origin object (des.db.update_image_path)
and moves freely.

[SAFETY] _resolve_dataset_image_path rejects missing paths, directories, and
non-image extensions (returns None -> a per-row error, never a crash).
[SAFETY] _reconcile_moved_image_path surfaces DB failures as error strings so
the caller can roll the moved file back — the library never silently points
at a non-existent path.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional, Tuple

from fastapi import HTTPException

import database as db
from config import ALLOWED_IMAGE_EXTENSIONS
from services.dataset_export.models import DatasetExportRequest
from services.dataset_naming import NamingError, resolve_collision
from services.dataset_session_service import (
    count_scan_manifest_paths,
    iter_scan_manifest_paths,
)
from utils.path_validation import normalize_user_path

logger = logging.getLogger("services.dataset_export_service")


def _svc():
    """Resolve facade-patched seams through services.dataset_export_service at call time.

    The pin suite patches ``render_stem`` on the facade module object
    (claude-dsexport-pins-REPORT.md §3); a ``from`` import here would freeze
    an independent binding that patch silently misses. The lazy import avoids
    a facade<->submodule load cycle.
    """
    import services.dataset_export_service as dataset_export_service

    return dataset_export_service


def _requested_item_count(request: DatasetExportRequest) -> int:
    total = len(list(_iter_unique_image_ids(request.image_ids or []))) + len(request.image_paths or [])
    for source in request.dataset_scan_tokens or []:
        token = str((source or {}).get("scan_token") or (source or {}).get("token") or "")
        if not token:
            continue
        exclude_paths = (source or {}).get("exclude_paths") or []
        try:
            total += count_scan_manifest_paths(token, exclude_paths)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    return total


def _iter_chunks(values: Iterable[Any], chunk_size: int) -> Iterator[List[Any]]:
    chunk: List[Any] = []
    for value in values or []:
        chunk.append(value)
        if len(chunk) >= chunk_size:
            yield chunk
            chunk = []
    if chunk:
        yield chunk


def _iter_unique_image_ids(values: Iterable[Any]) -> Iterator[int]:
    seen: set[int] = set()
    for raw in values or []:
        try:
            image_id = int(raw)
        except (TypeError, ValueError):
            continue
        if image_id <= 0 or image_id in seen:
            continue
        seen.add(image_id)
        yield image_id


def _resolve_dataset_image_path(raw_path: Any) -> Optional[str]:
    if not raw_path:
        return None
    try:
        resolved = Path(normalize_user_path(str(raw_path))).resolve()
    except (OSError, ValueError):
        return None
    if not resolved.exists() or not resolved.is_file():
        return None
    if resolved.suffix.lower() not in ALLOWED_IMAGE_EXTENSIONS:
        return None
    return str(resolved)


def _reconcile_moved_image_path(
    image_id: int,
    src_image_path: str,
    dst_image_path: str,
) -> Optional[str]:
    """Update the indexed library row after a move export.

    Returns ``None`` on success, or an error message string on failure.
    The caller is responsible for rolling the file back to ``src_image_path``
    when a failure is returned, so the DB and disk never diverge silently.

    This replaces the old ``except Exception: pass`` around
    ``db.update_image_path`` which silently left the gallery pointing at
    the pre-move path (Debt-03 for the dataset export path).
    """
    try:
        db.update_image_path(int(image_id), str(dst_image_path))
    except Exception as exc:  # noqa: BLE001 - we surface every DB failure
        logger.warning(
            "dataset-export: DB path update failed for image %s after move %s -> %s: %s",
            image_id, src_image_path, dst_image_path, exc,
        )
        return str(exc)
    # Best-effort: drop any stale caption/derived sidecars that were
    # keyed against the old location. We intentionally do not fail the
    # export if this cleanup misses something — the primary contract is
    # the DB row pointing at the new path.
    try:
        old_sidecar = Path(src_image_path).with_suffix(".txt")
        if old_sidecar.exists() and str(old_sidecar) != str(
            Path(dst_image_path).with_suffix(".txt")
        ):
            old_sidecar.unlink(missing_ok=True)
    except OSError:
        pass
    return None


def _dataset_sidecar_extension(content_mode: str) -> str:
    return ".json" if str(content_mode or "").strip().lower() == "json" else ".txt"


def _iter_requested_scan_paths(request: DatasetExportRequest) -> Iterator[str]:
    for source in request.dataset_scan_tokens or []:
        token = str((source or {}).get("scan_token") or (source or {}).get("token") or "")
        if not token:
            continue
        exclude_paths = {
            str(path)
            for path in ((source or {}).get("exclude_paths") or [])
            if str(path)
        }
        try:
            for path in iter_scan_manifest_paths(token):
                if str(path) not in exclude_paths:
                    yield str(path)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


def _allocate_sidecar_path(
    target_folder: Path,
    stem: str,
    caption_extension: str,
    *,
    overwrite_policy: str,
    used_paths: set[str],
) -> Tuple[Optional[Path], Optional[str]]:
    base = target_folder / f"{stem}{caption_extension}"
    if overwrite_policy == "overwrite":
        used_paths.add(str(base.resolve()))
        return base, None
    if overwrite_policy == "skip" and (base.exists() or str(base.resolve()) in used_paths):
        return None, "existing"
    candidate = base
    counter = 1
    while candidate.exists() or str(candidate.resolve()) in used_paths:
        candidate = target_folder / f"{stem}_{counter}{caption_extension}"
        counter += 1
        if counter > 9999:
            return None, "too_many_collisions"
    used_paths.add(str(candidate.resolve()))
    return candidate, None


def _plan_single_rename(
    record: Dict[str, Any],
    *,
    output_folder: Path,
    pattern: str,
    trigger: str,
    overwrite_policy: str,
    caption_extension: str,
    index: int,
    used_image_paths: set[str],
) -> Tuple[Optional[Path], Optional[Path], Optional[str]]:
    image_filename = record.get("filename") or os.path.basename(record.get("path") or "")
    ext = os.path.splitext(image_filename)[1] or ".png"
    try:
        stem = _svc().render_stem(
            pattern,
            image_filename=image_filename,
            index=index,
            trigger=trigger,
            generator=str(record.get("generator") or ""),
        )
    except NamingError as exc:
        return None, None, f"naming_error: {exc}"

    image_path = resolve_collision(
        output_folder,
        stem,
        ext,
        used_paths=used_image_paths,
        overwrite_policy=overwrite_policy,
    )
    if image_path is None:
        return None, None, "existing" if overwrite_policy == "skip" else "too_many_collisions"
    return image_path, output_folder / f"{image_path.stem}{caption_extension}", None


def _plan_beside_image_sidecar(
    record: Dict[str, Any],
    *,
    caption_extension: str,
    overwrite_policy: str,
    used_caption_paths: set[str],
) -> Tuple[Optional[Path], Optional[str]]:
    src_image_path = str(record.get("path") or "").strip()
    if not src_image_path:
        return None, "missing_source_path"
    src = Path(src_image_path)
    if not src.exists() or not src.is_file():
        return None, "source_missing"
    if not src.parent.is_dir():
        return None, "source_folder_missing"
    return _allocate_sidecar_path(
        src.parent,
        src.stem,
        caption_extension,
        overwrite_policy=overwrite_policy,
        used_paths=used_caption_paths,
    )


def _output_mode(request: Any) -> str:
    return str(getattr(request, "output_mode", "folder") or "folder").strip().lower()
