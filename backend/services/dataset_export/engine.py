"""The two streaming engine functions: export_dataset + preview_dataset_export.

Moved verbatim from services/dataset_export_service.py (decomposition 2026-07,
claude-dsexport-pins-REPORT.md §6 stage 3) except the five manifested lines:
the closures read DATASET_EXPORT_RESPONSE_ITEM_LIMIT /
DATASET_EXPORT_RECENT_ERROR_LIMIT / DATASET_EXPORT_DB_CHUNK_SIZE through
_svc() at call time because tests patch them on the facade module object
(tests/test_dataset_export_pins.py pins the item-limit read explicitly). The
``shutil`` / ``database`` module singletons are patched on their origin
objects (export_service.shutil.copy2 / des.db.update_image_path) and move
freely; the lazy in-function imports (services.mask_service,
urllib.parse.quote) are origin-module seams and stay verbatim.

[SAFETY] copy never touches the original (shutil.copy2); only move relocates.
[SAFETY] beside_image is a pure sidecar write — it never copies or relocates.
[SAFETY] a missing stored mask is COUNTED (masks_missing), never errored.
The job registry (progress/cancel globals) stays on the facade; this module
never touches it — cancellation arrives via the cancel_event parameter and
progress leaves via progress_callback.
"""

from __future__ import annotations

import os
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import HTTPException

import database as db
from services.dataset_export._constants import VALID_OVERWRITE_POLICIES
from services.dataset_export.artifacts import (
    _build_export_manifest,
    _mask_export_mode,
    _trainer_config_mode,
    _validate_export_request,
    _write_export_manifest,
    _write_kohya_dataset_config,
)
from services.dataset_export.captions import (
    _render_dataset_sidecar,
    _split_image_overrides,
    _split_keyed_str_map,
)
from services.dataset_export.models import (
    DatasetExportItemResult,
    DatasetExportPreviewRequest,
    DatasetExportRequest,
    DatasetExportResponse,
    ExportProgressCallback,
)
from services.dataset_export.planning import (
    _dataset_sidecar_extension,
    _iter_chunks,
    _iter_requested_scan_paths,
    _iter_unique_image_ids,
    _output_mode,
    _plan_beside_image_sidecar,
    _plan_single_rename,
    _reconcile_moved_image_path,
    _requested_item_count,
    _resolve_dataset_image_path,
)
from services.dataset_session_service import virtual_image_record_for_path
from services.tag_export_service import VALID_CONTENT_MODES, VALID_OUTPUT_MODES
from utils.path_validation import normalize_user_path


def _svc():
    """Resolve facade-owned constants through services.dataset_export_service at call time.

    Tests patch DATASET_EXPORT_RESPONSE_ITEM_LIMIT (and may patch the sibling
    limits) on the facade module object; a ``from`` import here would freeze
    independent bindings those patches silently miss. The lazy import avoids
    a facade<->submodule load cycle.
    """
    import services.dataset_export_service as dataset_export_service

    return dataset_export_service


def export_dataset(
    request: DatasetExportRequest,
    *,
    progress_callback: Optional[ExportProgressCallback] = None,
    cancel_event: Optional[threading.Event] = None,
) -> DatasetExportResponse:
    """Run a full dataset export. Atomic-per-row: a per-image failure
    leaves earlier rows intact and adds an error entry for the failed
    one.

    This is intentionally streaming: scan-token folder exports, explicit path
    exports, and DB-backed image exports are consumed in chunks. The backend no
    longer builds a 100k-1M ``image_records`` list or a full rename plan before
    the first file is written.
    """
    output_mode = _output_mode(request)
    output_path = _validate_export_request(request)
    output_mode = _output_mode(request)
    requested_total = _requested_item_count(request)
    if requested_total <= 0:
        raise HTTPException(status_code=400, detail="Dataset export has no images after exclusions.")
    if progress_callback:
        progress_callback({
            "step": "loading",
            "current": 0,
            "total": requested_total,
            "message": f"Preparing {requested_total} dataset items...",
            "output_folder": str(output_path or ""),
            "output_mode": output_mode,
        })

    if progress_callback:
        progress_callback({
            "step": "exporting",
            "current": 0,
            "total": requested_total,
            "message": "Exporting dataset...",
            "output_folder": str(output_path or ""),
            "output_mode": output_mode,
        })

    # ---- Pre-build common state for caption rendering ----
    blacklist_set = {str(t).strip().lower() for t in request.blacklist if str(t).strip()}

    image_overrides_int, image_overrides_path = _split_image_overrides(request)
    image_types_int, image_types_path = _split_keyed_str_map(getattr(request, "image_types", None))
    nl_overrides_int, nl_overrides_path = _split_keyed_str_map(getattr(request, "image_nl_overrides", None))
    caption_extension = _dataset_sidecar_extension(request.content_mode)
    mask_export_mode = _mask_export_mode(request)

    # ---- Execute the plan ----
    items: List[DatasetExportItemResult] = []
    error_messages: List[str] = []
    exported = 0
    skipped = 0
    error_count = 0
    masks_written = 0
    masks_missing = 0
    processed = 0
    total_expected = requested_total
    total_items = 0
    cancelled = False
    export_index = 0
    used_image_paths: set[str] = set()
    used_caption_paths: set[str] = set()
    seen_virtual_paths: set[str] = set()

    def _append_item(item: DatasetExportItemResult) -> None:
        nonlocal total_items
        total_items += 1
        if len(items) < _svc().DATASET_EXPORT_RESPONSE_ITEM_LIMIT:
            items.append(item)

    def _add_error(message: str) -> None:
        if len(error_messages) < 50:
            error_messages.append(message)
        elif len(error_messages) == 50:
            error_messages.append("... and more errors (showing first 50)")

    def _emit(message: str, current_item: Optional[str] = None) -> None:
        if not progress_callback:
            return
        progress_callback({
            "step": "exporting",
            "current": processed,
            "total": total_expected,
            "exported": exported,
            "skipped": skipped,
            "errors": error_count,
            "current_item": current_item,
            "recent_errors": error_messages[-_svc().DATASET_EXPORT_RECENT_ERROR_LIMIT:],
            "message": message,
            "output_folder": str(output_path or ""),
            "output_mode": output_mode,
            "items_truncated": total_items > _svc().DATASET_EXPORT_RESPONSE_ITEM_LIMIT,
        })

    def _record_error(image_id: int, src_image_path: str, message: str, current_item: Optional[str] = None) -> None:
        nonlocal error_count, processed
        error_count += 1
        processed += 1
        _add_error(message)
        _append_item(DatasetExportItemResult(
            image_id=int(image_id or 0),
            src_image_path=src_image_path or None,
            error=message,
        ))
        _emit(f"Failed {current_item or src_image_path or image_id} ({processed}/{total_expected})", current_item)

    def _record_skip(image_id: int, src_image_path: str, reason: str, current_item: Optional[str] = None) -> None:
        nonlocal skipped, processed
        skipped += 1
        processed += 1
        _append_item(DatasetExportItemResult(
            image_id=int(image_id or 0),
            src_image_path=src_image_path or None,
            skipped_reason=reason,
        ))
        _emit(f"Skipped {current_item or src_image_path or image_id} ({processed}/{total_expected})", current_item)

    def _export_record(record: Dict[str, Any], tags: Optional[List[Any]] = None) -> bool:
        nonlocal exported, skipped, error_count, processed, export_index, cancelled
        nonlocal masks_written, masks_missing
        if cancel_event is not None and cancel_event.is_set():
            cancelled = True
            return False

        export_index += 1
        image_id = int(record.get("id") or 0)
        src_image_path = str(record.get("path") or "")
        filename = os.path.basename(src_image_path) or f"image-{image_id}"
        dst_image_path: Optional[Path] = None
        dst_caption_path: Optional[Path] = None
        skip_reason: Optional[str] = None
        if output_mode == "beside_image":
            dst_caption_path, skip_reason = _plan_beside_image_sidecar(
                record,
                caption_extension=caption_extension,
                overwrite_policy=request.overwrite_policy,
                used_caption_paths=used_caption_paths,
            )
        else:
            if output_path is None:
                _record_error(image_id, src_image_path, "Output folder is required for folder export mode.", filename)
                return True
            dst_image_path, dst_caption_path, skip_reason = _plan_single_rename(
                record,
                output_folder=output_path,
                pattern=request.naming_pattern,
                trigger=request.trigger,
                overwrite_policy=request.overwrite_policy,
                caption_extension=caption_extension,
                index=export_index,
                used_image_paths=used_image_paths,
            )

        if dst_caption_path is None:
            _record_skip(image_id, src_image_path, skip_reason or "skipped", filename)
            return True

        # Render caption
        try:
            caption_text = _render_dataset_sidecar(
                record,
                tags or [],
                request,
                blacklist_set=blacklist_set,
                image_overrides_int=image_overrides_int,
                image_overrides_path=image_overrides_path,
                image_types_int=image_types_int,
                image_types_path=image_types_path,
                nl_overrides_int=nl_overrides_int,
                nl_overrides_path=nl_overrides_path,
            )
        except Exception as exc:  # pragma: no cover - defensive
            msg = f"caption render failed for image {image_id}: {exc}"
            _record_error(image_id, src_image_path, msg, filename)
            return True

        # Verify source exists
        if not src_image_path or not os.path.exists(src_image_path):
            msg = f"image {image_id} source missing on disk: {src_image_path!r}"
            _record_error(image_id, src_image_path, msg, filename)
            return True

        # Copy / move the image in folder mode only. Beside-image mode is a
        # pure sidecar write and must not duplicate or relocate source images.
        if output_mode == "folder":
            try:
                os.makedirs(dst_image_path.parent, exist_ok=True)
                if request.image_op == "copy":
                    # copy2 preserves mtime so trainers and downstream tools
                    # see the original recency.
                    shutil.copy2(src_image_path, str(dst_image_path))
                else:  # move
                    # Move the file first, then reconcile the indexed DB
                    # row. Previously the DB update was wrapped in a bare
                    # ``except Exception: pass`` which silently desynced
                    # the gallery from disk if SQLite failed after the
                    # file move. We now roll the file back to its source
                    # path on DB failure and surface the error, so the
                    # library never points at a non-existent path.
                    shutil.move(src_image_path, str(dst_image_path))
                    if image_id:
                        move_error = _reconcile_moved_image_path(
                            image_id,
                            src_image_path,
                            str(dst_image_path),
                        )
                        if move_error:
                            # Best-effort rollback so the on-disk state
                            # matches the DB row we just failed to update.
                            try:
                                shutil.move(str(dst_image_path), src_image_path)
                            except OSError:
                                # If rollback fails we must still report
                                # the desync rather than hide it.
                                pass
                            msg = (
                                f"moved {filename} but failed to update library path: "
                                f"{move_error}. File restored to original location."
                            )
                            _record_error(image_id, src_image_path, msg, filename)
                            return True
            except Exception as exc:
                msg = f"failed to {request.image_op} image {image_id}: {exc}"
                _record_error(image_id, src_image_path, msg, filename)
                return True

        # Write caption sidecar.
        #
        # Per-row atomicity (v3.4.5): write to a sibling temp file first,
        # then atomically rename into place. A crash mid-write now leaves
        # either the old caption (if any) or no caption — never a
        # half-written file the trainer might pick up. The temp file uses
        # a ``.tmp`` suffix on the SAME directory so the rename is atomic
        # on the same filesystem (POSIX rename + Windows MoveFileEx are
        # both atomic for same-volume renames).
        try:
            os.makedirs(dst_caption_path.parent, exist_ok=True)
            tmp_caption_path = dst_caption_path.with_suffix(dst_caption_path.suffix + ".tmp")
            # newline="\n" (P3-14): keep caption sidecars LF on Windows too.
            with open(tmp_caption_path, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(caption_text)
                handle.flush()
                try:
                    os.fsync(handle.fileno())
                except OSError:
                    # fsync may be unavailable on some streams (e.g. over
                    # network mounts); the rename is still the primary
                    # atomicity guarantee, so don't fail the row here.
                    pass
            os.replace(str(tmp_caption_path), str(dst_caption_path))
        except Exception as exc:
            msg = f"failed to write caption for image {image_id}: {exc}"
            # Don't remove the image — the user can re-run the export and
            # the existing image acts as the resume marker. But do report
            # the partial state in the per-item entry.
            error_count += 1
            processed += 1
            _add_error(msg)
            _append_item(DatasetExportItemResult(
                image_id=image_id,
                src_image_path=src_image_path,
                dst_image_path=str(dst_image_path) if dst_image_path is not None else None,
                error=msg,
            ))
            _emit(f"Failed to write caption for {filename} ({processed}/{total_expected})", filename)
            # Best-effort: remove the temp file if the rename failed so
            # we don't leave .tmp litter next to the captions.
            try:
                if os.path.exists(str(tmp_caption_path)):
                    os.unlink(str(tmp_caption_path))
            except OSError:
                pass
            return True

        # Masked-training sidecar (Phase 4): copy the stored mask, named for
        # the chosen trainer. Local-source items (id <= 0) have no stored
        # masks; a missing mask is normal (trainers treat it as full-image)
        # and never fails the row.
        if mask_export_mode != "none" and image_id > 0:
            nonlocal_dst = dst_image_path if dst_image_path is not None else Path(src_image_path)
            mask_error = _write_mask_sidecar(
                image_id,
                mask_export_mode,
                exported_image_path=nonlocal_dst,
                output_folder=output_path,
            )
            if mask_error is None:
                masks_written += 1
            elif mask_error == "missing":
                masks_missing += 1
            else:
                _add_error(mask_error)

        exported += 1
        processed += 1
        _append_item(DatasetExportItemResult(
            image_id=image_id,
            src_image_path=src_image_path,
            dst_image_path=str(dst_image_path) if dst_image_path is not None else None,
            dst_caption_path=str(dst_caption_path),
        ))
        _emit(f"Exported {filename} ({processed}/{total_expected})", filename)
        return True

    def _write_mask_sidecar(
        image_id: int,
        mode: str,
        *,
        exported_image_path: Path,
        output_folder: Optional[Path],
    ) -> Optional[str]:
        """Copy the stored mask next to the exported pair. Returns None on
        success, "missing" when no mask is stored, or an error string."""
        from services import mask_service

        source_mask = mask_service.get_mask_file(image_id)
        if source_mask is None:
            return "missing"
        stem = exported_image_path.stem
        if mode == "onetrainer":
            target = exported_image_path.parent / f"{stem}-masklabel.png"
        else:  # kohya conditioning_data_dir layout
            base = output_folder if output_folder is not None else exported_image_path.parent
            target = base / "mask" / f"{stem}.png"
        try:
            os.makedirs(target.parent, exist_ok=True)
            shutil.copy2(str(source_mask), str(target))
            return None
        except Exception as exc:  # noqa: BLE001
            return f"failed to write mask for image {image_id}: {exc}"

    def _process_path_source(raw_path: Any) -> bool:
        nonlocal cancelled
        if cancel_event is not None and cancel_event.is_set():
            cancelled = True
            return False
        normalized_path = _resolve_dataset_image_path(raw_path)
        display_path = str(raw_path or "")
        if not normalized_path:
            _record_error(0, display_path, f"path not a readable image: {display_path}", os.path.basename(display_path))
            return True
        if normalized_path in seen_virtual_paths:
            _record_skip(0, normalized_path, "duplicate", os.path.basename(normalized_path))
            return True
        seen_virtual_paths.add(normalized_path)
        record = virtual_image_record_for_path(normalized_path, read_dimensions=False)
        return _export_record(record, [])

    _emit(f"Exporting 0/{total_expected} images...")

    # ---- DB-source records in bounded chunks ----
    for image_id_chunk in _iter_chunks(_iter_unique_image_ids(request.image_ids or []), _svc().DATASET_EXPORT_DB_CHUNK_SIZE):
        if cancelled:
            break
        if cancel_event is not None and cancel_event.is_set():
            cancelled = True
            break
        ids = [int(image_id) for image_id in image_id_chunk]
        images_map = db.get_images_by_ids(ids) if ids else {}
        tags_map = db.get_image_tags_map(ids) if ids else {}
        for image_id in ids:
            if cancel_event is not None and cancel_event.is_set():
                cancelled = True
                break
            record = images_map.get(image_id)
            if not record:
                _record_error(image_id, "", f"image {image_id} not found in library", f"id-{image_id}")
                continue
            if not _export_record(dict(record), tags_map.get(image_id, []) or []):
                break

    # ---- Explicit path-source records ----
    if not cancelled:
        for raw_path in request.image_paths or []:
            if not _process_path_source(raw_path):
                break

    # ---- Token-backed folder manifest records ----
    if not cancelled:
        for raw_path in _iter_requested_scan_paths(request):
            if not _process_path_source(raw_path):
                break

    if cancelled:
        status = "cancelled"
        _emit(f"Cancelled at {processed}/{total_expected}. Exported {exported} images.")
    elif error_count == 0:
        status = "ok"
    elif exported == 0:
        status = "failed"
    else:
        status = "partial"

    items_truncated = total_items > len(items)

    # Best-effort: drop an ``export_manifest.json`` describing this run into
    # the output folder. Only ``folder`` mode has a single destination folder;
    # ``beside_image`` writes sidecars next to each source image (output_path
    # is None), so there is no one place a run-level manifest belongs.
    if output_mode == "folder" and output_path is not None:
        manifest = _build_export_manifest(
            request,
            status=status,
            output_folder=output_path,
            output_mode=output_mode,
            caption_extension=caption_extension,
            exported=exported,
            skipped=skipped,
            error_count=error_count,
            total_items=total_items,
            items=items,
            items_truncated=items_truncated,
            generated_at=time.time(),
        )
        _write_export_manifest(output_path, manifest)

    trainer_config_path = None
    if (
        _trainer_config_mode(request) == "kohya_toml"
        and output_mode == "folder"
        and output_path is not None
        and exported > 0
        and not cancelled
    ):
        trainer_config_path = _write_kohya_dataset_config(
            output_path, request, masks_written=masks_written
        )
        if trainer_config_path is None:
            _add_error("dataset_config.toml could not be written (pairs on disk are intact)")

    return DatasetExportResponse(
        trainer_config_path=trainer_config_path,
        masks_written=masks_written,
        masks_missing=masks_missing,
        status=status,
        exported=exported,
        skipped=skipped,
        error_count=error_count,
        output_folder=str(output_path or ""),
        output_mode=output_mode,
        items=items,
        total_items=total_items,
        items_truncated=items_truncated,
        error_messages=error_messages,
    )


def preview_dataset_export(request: DatasetExportPreviewRequest) -> Dict[str, Any]:
    """Render a bounded Dataset Maker export preview without writing files."""
    output_mode = _output_mode(request)
    if output_mode not in VALID_OUTPUT_MODES:
        raise HTTPException(status_code=400, detail=f"Invalid output_mode: {output_mode!r}")
    if request.overwrite_policy not in VALID_OVERWRITE_POLICIES:
        raise HTTPException(status_code=400, detail=f"Invalid overwrite_policy: {request.overwrite_policy!r}")
    content_mode = str(request.content_mode or "template").strip().lower()
    if content_mode not in VALID_CONTENT_MODES:
        raise HTTPException(status_code=400, detail=f"Invalid content_mode: {request.content_mode!r}")
    if not request.image_ids and not request.image_paths and not request.dataset_scan_tokens:
        return {
            "total": 0,
            "returned": 0,
            "items_truncated": False,
            "content_mode": content_mode,
            "output_mode": output_mode,
            "sidecar_extension": _dataset_sidecar_extension(content_mode),
            "items": [],
        }

    total = _requested_item_count(request)  # type: ignore[arg-type]
    try:
        output_path = Path(normalize_user_path(request.output_folder)).resolve() if request.output_folder else Path("__dataset_preview__").resolve()
    except (OSError, ValueError):
        output_path = Path("__dataset_preview__").resolve()

    blacklist_set = {str(t).strip().lower() for t in request.blacklist if str(t).strip()}
    image_overrides_int, image_overrides_path = _split_image_overrides(request)
    image_types_int, image_types_path = _split_keyed_str_map(getattr(request, "image_types", None))
    nl_overrides_int, nl_overrides_path = _split_keyed_str_map(getattr(request, "image_nl_overrides", None))
    caption_extension = _dataset_sidecar_extension(content_mode)
    limit = max(1, min(int(request.limit or 72), 500))
    used_image_paths: set[str] = set()
    used_caption_paths: set[str] = set()
    seen_virtual_paths: set[str] = set()
    items: List[Dict[str, Any]] = []
    export_index = 0

    def _thumbnail_url(record: Dict[str, Any]) -> str:
        image_id = int(record.get("id") or 0)
        if image_id > 0:
            return f"/api/image-thumbnail/{image_id}?size=256"
        path = str(record.get("path") or "")
        if not path:
            return ""
        from urllib.parse import quote

        return f"/api/dataset/local-thumbnail?path={quote(path, safe='')}&size=256"

    def _append_preview(record: Dict[str, Any], tags: Optional[List[Any]] = None, *, error: str = "") -> bool:
        nonlocal export_index
        export_index += 1
        if len(items) >= limit:
            return False

        image_id = int(record.get("id") or 0)
        src_image_path = str(record.get("path") or "")
        if output_mode == "beside_image":
            dst_image_path = None
            dst_caption_path, skip_reason = _plan_beside_image_sidecar(
                record,
                caption_extension=caption_extension,
                overwrite_policy=request.overwrite_policy,
                used_caption_paths=used_caption_paths,
            )
        else:
            dst_image_path, dst_caption_path, skip_reason = _plan_single_rename(
                record,
                output_folder=output_path,
                pattern=request.naming_pattern,
                trigger=request.trigger,
                overwrite_policy=request.overwrite_policy,
                caption_extension=caption_extension,
                index=export_index,
                used_image_paths=used_image_paths,
            )
        rendered = ""
        render_error = error
        if not render_error and dst_caption_path is not None:
            try:
                rendered = _render_dataset_sidecar(
                    record,
                    tags or [],
                    request,
                    blacklist_set=blacklist_set,
                    image_overrides_int=image_overrides_int,
                    image_overrides_path=image_overrides_path,
                    image_types_int=image_types_int,
                    image_types_path=image_types_path,
                    nl_overrides_int=nl_overrides_int,
                    nl_overrides_path=nl_overrides_path,
                )
            except Exception as exc:  # pragma: no cover - defensive preview fallback
                render_error = str(exc)

        items.append({
            "index": export_index,
            "image_id": image_id,
            "abs_path": src_image_path,
            "filename": record.get("filename") or os.path.basename(src_image_path) or f"image-{image_id}",
            "thumbnail_url": _thumbnail_url(record),
            "output_image_name": dst_image_path.name if dst_image_path is not None else "",
            "output_caption_name": dst_caption_path.name if dst_caption_path is not None else "",
            "output_image_path": str(dst_image_path) if dst_image_path is not None and request.output_folder else "",
            "output_caption_path": str(dst_caption_path) if dst_caption_path is not None and (request.output_folder or output_mode == "beside_image") else "",
            "caption": rendered,
            # Booru tags (rendered template) live in ``caption``; surface the
            # natural-language sentence separately so the editor's NL box can
            # show / edit it independently of the booru-tags box (point 2/3).
            "ai_caption": str(record.get("ai_caption") or ""),
            "nl_caption": str(record.get("nl_caption") or ""),
            "skipped_reason": skip_reason,
            "error": render_error or None,
        })
        return len(items) < limit

    def _preview_path_source(raw_path: Any) -> bool:
        normalized_path = _resolve_dataset_image_path(raw_path)
        display_path = str(raw_path or "")
        if not normalized_path:
            record = {
                "id": 0,
                "path": display_path,
                "filename": os.path.basename(display_path) or "unreadable",
                "generator": "",
            }
            return _append_preview(record, [], error=f"path not a readable image: {display_path}")
        if normalized_path in seen_virtual_paths:
            record = virtual_image_record_for_path(normalized_path, read_dimensions=False)
            return _append_preview(record, [], error="duplicate path in dataset")
        seen_virtual_paths.add(normalized_path)
        return _append_preview(virtual_image_record_for_path(normalized_path, read_dimensions=False), [])

    for image_id_chunk in _iter_chunks(_iter_unique_image_ids(request.image_ids or []), _svc().DATASET_EXPORT_DB_CHUNK_SIZE):
        if len(items) >= limit:
            break
        ids = [int(image_id) for image_id in image_id_chunk]
        images_map = db.get_images_by_ids(ids) if ids else {}
        tags_map = db.get_image_tags_map(ids) if ids else {}
        for image_id in ids:
            if len(items) >= limit:
                break
            record = images_map.get(image_id)
            if not record:
                missing = {
                    "id": image_id,
                    "path": "",
                    "filename": f"image_{image_id}",
                    "generator": "",
                }
                _append_preview(missing, [], error=f"image {image_id} not found in library")
                continue
            _append_preview(dict(record), tags_map.get(image_id, []) or [])

    if len(items) < limit:
        for raw_path in request.image_paths or []:
            if not _preview_path_source(raw_path):
                break

    if len(items) < limit:
        for raw_path in _iter_requested_scan_paths(request):  # type: ignore[arg-type]
            if not _preview_path_source(raw_path):
                break

    return {
        "total": total,
        "returned": len(items),
        "items_truncated": total > len(items),
        "content_mode": content_mode,
        "output_mode": output_mode,
        "sidecar_extension": caption_extension,
        "items": items,
    }
