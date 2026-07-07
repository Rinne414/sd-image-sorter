"""``/api/dataset/*`` routes.

Phase 2 of the Dataset Maker tab introduced in v3.2.2 (issue #5
points 5/6 follow-up). Endpoints:

* ``POST /api/dataset/export`` — copy/move images + write captions
  to one folder under a chosen naming pattern (legacy + path-mode).
* ``POST /api/dataset/folder-scan`` — scan a folder for images and
  return per-image metadata WITHOUT touching the main library DB.
  Backs the "📁 import folder directly" Dataset Maker entry point.
"""
from __future__ import annotations

import logging
import io
import os
import asyncio
from datetime import datetime, timezone
from email.utils import format_datetime
from itertools import chain
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field

from services.dataset_audit_service import AUDIT_RESPONSE_ITEM_LIMIT, audit_dataset
from services.dataset_export_service import (
    DatasetExportPreviewRequest,
    DatasetExportRequest,
    DatasetExportResponse,
    DatasetExportStartResponse,
    cancel_dataset_export,
    export_dataset,
    get_dataset_export_progress,
    preview_dataset_export,
    start_dataset_export,
)
from services.dataset_session_service import (
    MAX_SCAN_RESULTS,
    is_path_in_dataset_session,
    iter_scan_manifest_paths,
    resolve_paths_for_dataset,
    scan_folder_for_dataset,
    upload_files_for_dataset,
)
import services.dataset_translate_service as _translate_service
from services.dataset_translate_service import (
    DEFAULT_CACHE_DIR as _TRANSLATE_DEFAULT_CACHE_DIR,  # noqa: F401
    DatasetTranslateRequest,
    translate_dataset_texts,
)
from thumbnail_cache import generate_placeholder_thumbnail, get_thumbnail_async

# Re-export the translation internals tests monkeypatch through the router
# module, so the service extraction does not break the existing test suite.
# Tests do: monkeypatch.setattr(dataset_router, '_translate_external_texts', ...)
_DIRECT_TRANSLATION_PROVIDER_ALIASES = _translate_service._DIRECT_TRANSLATION_PROVIDER_ALIASES
_GLOBAL_FREE_PROVIDER_CHAIN = _translate_service._GLOBAL_FREE_PROVIDER_CHAIN
_MAINLAND_FREE_PROVIDER_CHAIN = _translate_service._MAINLAND_FREE_PROVIDER_CHAIN
_TRANSLATION_CACHE = _translate_service._TRANSLATION_CACHE
_TRANSLATORS_PROVIDER_ALIASES = _translate_service._TRANSLATORS_PROVIDER_ALIASES
_translate_external_texts = _translate_service._translate_external_texts
_translate_external_uncached = _translate_service._translate_external_uncached
_translate_translators_web = _translate_service._translate_translators_web


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["dataset"])


@router.post(
    "/dataset/export",
    response_model=DatasetExportResponse,
    summary="Export a curated dataset (images + captions) to one folder",
    description=(
        "Combined image-and-caption export for LoRA training datasets. "
        "Renames every image according to the supplied pattern, copies "
        "(or moves) it to the output folder, and writes the matching "
        "``.txt`` sidecar with the same stem.\n\n"
        "Pattern variables: ``{filename}``, ``{index}``, ``{index:03d}`` "
        "(0-padded counter), ``{trigger}``, ``{generator}``, ``{ext}``, "
        "``{date}``."
    ),
    responses={
        200: {"description": "Export completed (status field is ``ok`` / ``partial`` / ``failed``)"},
        400: {"description": "Invalid request payload (output folder, image_op, or overwrite_policy)"},
    },
)
def post_dataset_export(payload: DatasetExportRequest) -> DatasetExportResponse:
    try:
        return export_dataset(payload)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Dataset export failed")
        raise HTTPException(
            status_code=500,
            detail="Dataset export failed. / 数据集导出失败。",
        ) from exc


@router.post(
    "/dataset/export-preview",
    summary="Preview Dataset Maker export sidecars without writing files",
    responses={
        200: {"description": "Preview rows rendered with the same caption engine as export"},
        400: {"description": "Invalid request payload"},
    },
)
def post_dataset_export_preview(payload: DatasetExportPreviewRequest) -> Dict[str, Any]:
    try:
        return preview_dataset_export(payload)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Dataset export preview failed")
        raise HTTPException(
            status_code=500,
            detail="Dataset export preview failed. / 数据集导出预览失败。",
        ) from exc


class DatasetExportJobRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    job_id: Optional[str] = Field(default=None, min_length=1, max_length=64)


@router.post(
    "/dataset/export/start",
    response_model=DatasetExportStartResponse,
    summary="Start a background dataset export job",
    responses={
        200: {"description": "Export job started"},
        400: {"description": "Invalid request payload"},
        409: {"description": "Another dataset export is already running"},
    },
)
def post_dataset_export_start(payload: DatasetExportRequest) -> DatasetExportStartResponse:
    try:
        return start_dataset_export(payload)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Dataset export start failed")
        raise HTTPException(
            status_code=500,
            detail="Dataset export start failed. / 数据集导出启动失败。",
        ) from exc


@router.get(
    "/dataset/export/progress",
    summary="Get background dataset export progress",
)
def get_dataset_export_job_progress(job_id: Optional[str] = None) -> Dict[str, Any]:
    try:
        return get_dataset_export_progress(job_id=job_id)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Dataset export progress failed")
        raise HTTPException(
            status_code=500,
            detail="Dataset export progress failed. / 获取导出进度失败。",
        ) from exc


@router.post(
    "/dataset/export/cancel",
    summary="Cancel the active background dataset export job",
)
def post_dataset_export_cancel(
    payload: Optional[DatasetExportJobRequest] = None,
) -> Dict[str, Any]:
    try:
        return cancel_dataset_export(job_id=payload.job_id if payload else None)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Dataset export cancel failed")
        raise HTTPException(
            status_code=500,
            detail="Dataset export cancel failed. / 取消导出失败。",
        ) from exc


# ------------------------------ folder-scan ------------------------------

class DatasetFolderScanRequest(BaseModel):
    """Request body for ``POST /api/dataset/folder-scan``.

    The ``recursive`` flag is opt-in; default is non-recursive so a
    100k-image directory tree doesn't spike the response size by
    accident. Frontend can re-call with ``recursive=True`` once the
    user is sure.
    """
    model_config = ConfigDict(extra="ignore")

    folder_path: Optional[str] = Field(default=None, min_length=1, max_length=4096)
    recursive: bool = False
    limit: int = Field(default=MAX_SCAN_RESULTS, ge=1, le=MAX_SCAN_RESULTS)
    offset: int = Field(default=0, ge=0)
    scan_token: Optional[str] = Field(default=None, min_length=1, max_length=128)
    include_thumbnails: bool = True


@router.post(
    "/dataset/folder-scan",
    summary="Scan a folder into the Dataset Maker session without DB writes",
    description=(
        "Lists image files in ``folder_path`` and returns per-image "
        "metadata (``ds_id``, ``abs_path``, dimensions, mtime, base64 "
        "thumbnail) the frontend can show in the Dataset Maker queue "
        "WITHOUT registering the images in the main library DB.\n\n"
        "This is the 'small gallery' / 'local-only workspace' path: a "
        "user can curate a LoRA training set from a folder, run audit "
        "and Smart Tag against it, and export the result, all without "
        "polluting the gallery's main image index."
    ),
    responses={
        200: {"description": "Scan succeeded — returns folder_path, items[], total_files_seen, skipped_unreadable, truncated"},
        400: {"description": "Invalid folder path or path is not a directory"},
    },
)
def post_dataset_folder_scan(payload: DatasetFolderScanRequest) -> Dict[str, Any]:
    try:
        return scan_folder_for_dataset(
            payload.folder_path or "",
            recursive=bool(payload.recursive),
            limit=int(payload.limit),
            offset=int(payload.offset),
            scan_token=payload.scan_token,
            include_thumbnails=bool(payload.include_thumbnails),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Dataset folder-scan failed")
        raise HTTPException(
            status_code=500,
            detail="Folder scan failed. / 文件夹扫描失败。",
        ) from exc


@router.get(
    "/dataset/local-thumbnail",
    summary="Get a thumbnail for a Dataset Maker local-source path",
    responses={
        200: {"description": "Thumbnail image (WebP format)"},
        403: {"description": "Path was not surfaced by an active Dataset Maker session"},
        404: {"description": "Image path is not readable"},
    },
)
async def get_dataset_local_thumbnail(
    path: str = Query(..., min_length=1, max_length=4096),
    size: int = Query(default=256, ge=1, le=4096),
) -> StreamingResponse:
    # Security gate: the thumbnail endpoint must only serve paths the
    # backend itself surfaced via folder-scan, upload-files, or a
    # scan-token manifest. Without this check ``?path=<anywhere>`` would
    # be an arbitrary-host-file read oracle.
    if not is_path_in_dataset_session(path):
        raise HTTPException(
            status_code=403,
            detail="Path is not part of an active Dataset Maker session. "
                   "Scan the folder or upload the file first.",
        )
    resolved = resolve_paths_for_dataset([path])
    if not resolved:
        raise HTTPException(status_code=404, detail="Image path is not readable")

    source_path = resolved[0]
    if os.path.islink(source_path):
        raise HTTPException(status_code=404, detail="Image path is not readable")

    try:
        if int(size) > 512:
            # Large thumbnails require real PIL decode work; run it off
            # the event loop so a 4K source can't block other requests.
            def _render_large_thumbnail(sp: str, sz: int) -> bytes:
                with Image.open(sp) as img:
                    resample = getattr(Image, "Resampling", Image).LANCZOS
                    working = img.convert("RGB") if img.mode not in ("RGB", "L") else img.copy()
                    working.thumbnail((int(sz), int(sz)), resample)
                    buf = io.BytesIO()
                    working.save(buf, format="WEBP", quality=92, method=4)
                    return buf.getvalue()

            thumbnail_bytes = await asyncio.to_thread(_render_large_thumbnail, source_path, int(size))
            stat = os.stat(source_path)
            return StreamingResponse(
                io.BytesIO(thumbnail_bytes),
                media_type="image/webp",
                headers={
                    "Cache-Control": "public, max-age=3600",
                    "Last-Modified": format_datetime(
                        datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc),
                        usegmt=True,
                    ),
                    "X-Thumbnail-Cache": "BYPASS",
                },
            )
        thumbnail_bytes, last_modified, cache_hit = await get_thumbnail_async(source_path, size)
        return StreamingResponse(
            io.BytesIO(thumbnail_bytes),
            media_type="image/webp",
            headers={
                "Cache-Control": f"public, max-age={86400 if cache_hit else 3600}",
                "Last-Modified": format_datetime(last_modified, usegmt=True),
                "X-Thumbnail-Cache": "HIT" if cache_hit else "MISS",
            },
        )
    except (UnidentifiedImageError, OSError):
        placeholder_bytes = generate_placeholder_thumbnail(size)
        return StreamingResponse(
            io.BytesIO(placeholder_bytes),
            media_type="image/webp",
            headers={
                "Cache-Control": "no-cache",
                "X-Thumbnail-Cache": "MISS",
                "X-Thumbnail-Placeholder": "UNREADABLE",
            },
        )


# ------------------------------ audit ------------------------------

class DatasetAuditRequest(BaseModel):
    """Request body for ``POST /api/dataset/audit``.

    All threshold fields are optional. ``None`` means "do not flag
    items along that axis" — the user explicitly asked for no hard
    limits in v3.2.2 (issue #5 follow-up).
    """
    model_config = ConfigDict(extra="ignore")

    image_ids: List[int] = Field(default_factory=list)
    image_paths: List[str] = Field(default_factory=list)
    dataset_scan_tokens: List[Dict[str, Any]] = Field(default_factory=list, max_length=100)
    aesthetic_max: Optional[float] = Field(default=None)
    phash_max: Optional[int] = Field(default=None, ge=0, le=64)
    dim_min: Optional[int] = Field(default=None, ge=0, le=8192)
    enable_aesthetic: bool = True
    enable_phash: bool = True
    enable_untagged: bool = True
    extra_tag_counts: Dict[str, int] = Field(default_factory=dict)
    item_limit: int = Field(default=AUDIT_RESPONSE_ITEM_LIMIT, ge=0, le=50_000)


@router.post(
    "/dataset/audit",
    summary="Audit a Dataset Maker session for LoRA-trainer readiness",
    description=(
        "Inspects every image in the supplied session (gallery-source "
        "and / or path-source) and returns a flat summary plus per-image "
        "flags for the four checks the frontend surfaces:\n\n"
        "  * ``low_quality`` — aesthetic score below ``aesthetic_max``\n"
        "  * ``untagged``    — image has zero tags (or, for local items, "
        "an empty caption)\n"
        "  * ``small``       — min(width,height) below ``dim_min``\n"
        "  * Duplicates are returned as ``duplicate_groups`` keyed by "
        "phash; an entry with ``len(image_ids) >= 2`` is a near-duplicate "
        "cluster.\n\n"
        "All thresholds are optional. ``None`` skips that axis entirely "
        "so the user can ask for a fast 'what's untagged?' pass without "
        "paying the aesthetic or phash inference cost."
    ),
    responses={
        200: {"description": "Audit succeeded — returns summary, items, duplicate_groups"},
        400: {"description": "Bad request payload"},
    },
)
def post_dataset_audit(payload: DatasetAuditRequest) -> Dict[str, Any]:
    if not payload.image_ids and not payload.image_paths and not payload.dataset_scan_tokens:
        raise HTTPException(status_code=400, detail="Audit needs image_ids, image_paths, or dataset_scan_tokens.")
    image_path_iterables = [list(payload.image_paths or [])]
    for source in payload.dataset_scan_tokens or []:
        token = str((source or {}).get("scan_token") or (source or {}).get("token") or "")
        if not token:
            continue
        exclude_paths = {
            str(path)
            for path in ((source or {}).get("exclude_paths") or [])
            if str(path)
        }
        try:
            def _filtered_paths(scan_token: str = token, excluded: set[str] = set(exclude_paths)):
                try:
                    for path in iter_scan_manifest_paths(scan_token):
                        if str(path) not in excluded:
                            yield path
                except ValueError as exc:
                    raise HTTPException(status_code=400, detail=str(exc)) from exc

            image_path_iterables.append(_filtered_paths())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        return audit_dataset(
            image_ids=payload.image_ids,
            image_paths=chain.from_iterable(image_path_iterables),
            aesthetic_max=payload.aesthetic_max,
            phash_max=payload.phash_max,
            dim_min=payload.dim_min,
            extra_tag_counts=payload.extra_tag_counts,
            enable_aesthetic=bool(payload.enable_aesthetic),
            enable_phash=bool(payload.enable_phash),
            enable_untagged=bool(payload.enable_untagged),
            item_limit=int(payload.item_limit),
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Dataset audit failed")
        raise HTTPException(
            status_code=500,
            detail="Audit failed. / 数据集审核失败。",
        ) from exc


# ------------------------------ vocab ------------------------------

class DatasetVocabRequest(BaseModel):
    """Request body for ``POST /api/dataset/vocab``.

    Returns the union of tags across ``image_ids`` (DB-source) and
    ``path_caption_overrides`` (local-source captions split by comma)
    sorted by descending frequency, optionally truncated to ``top_n``.

    Each entry includes a ``sample_image_id`` from the DB-source rows
    so the frontend can preview-link the tag to a representative
    image; for path-only items the sample_image_id is 0.
    """
    model_config = ConfigDict(extra="ignore")

    image_ids: List[int] = Field(default_factory=list)
    path_caption_overrides: Dict[str, str] = Field(default_factory=dict)
    top_n: int = Field(default=300, ge=1, le=2000)


@router.post(
    "/dataset/vocab",
    summary="Tag frequency vocabulary for the active Dataset Maker session",
    description=(
        "Returns the union of tags across the supplied gallery image_ids "
        "(read from the DB tag table) and any per-path caption overrides "
        "(local-source items split by comma). Sorted by descending "
        "frequency, optionally truncated to ``top_n``."
    ),
)
def post_dataset_vocab(payload: DatasetVocabRequest) -> Dict[str, Any]:
    counts: Dict[str, int] = {}
    samples: Dict[str, int] = {}

    image_ids_clean = list({int(i) for i in payload.image_ids if int(i) > 0})
    if image_ids_clean:
        try:
            import database as db
            tags_map = db.get_image_tags_map(image_ids_clean) or {}
        except Exception as exc:
            logger.warning("vocab: DB tag lookup failed: %s", exc)
            tags_map = {}
        for image_id, tag_rows in tags_map.items():
            for tag_row in tag_rows or []:
                tag = ""
                if isinstance(tag_row, dict):
                    tag = str(tag_row.get("tag") or "").strip()
                else:
                    tag = str(tag_row or "").strip()
                if not tag:
                    continue
                counts[tag] = counts.get(tag, 0) + 1
                samples.setdefault(tag, int(image_id))

    # Local-source: split caption overrides by comma to produce an
    # approximate tag list. Captions are NL+booru-mixed so this is
    # rough, but it's good enough to surface "trigger word X appears
    # in 18 of 20 captions" — the most common Dataset Maker question.
    for _path, caption in (payload.path_caption_overrides or {}).items():
        if not caption:
            continue
        for token in str(caption).split(","):
            tag = token.strip()
            if not tag:
                continue
            counts[tag] = counts.get(tag, 0) + 1
            samples.setdefault(tag, 0)

    # Sort: highest count first, alphabetical for ties.
    ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0].lower()))
    if payload.top_n and len(ordered) > payload.top_n:
        ordered = ordered[: payload.top_n]

    return {
        "vocab": [
            {"tag": tag, "count": count, "sample_image_id": samples.get(tag, 0)}
            for tag, count in ordered
        ],
        "total_unique_tags": len(counts),
    }




@router.post(
    "/dataset/translate",
    summary="Translate Dataset Maker caption/tag text for Chinese review",
    description=(
        "Translate up to 200 caption/tag strings for human review. "
        "`provider_mode='vlm'` (default) uses the configured VLM endpoint "
        "(400 if none configured); any other value uses no-key web providers "
        "selected via `external_provider` — a single provider name fails fast, "
        "while chain keywords (`auto`/`free`/`auto_global`, or "
        "`auto_cn`/`mainland`/`china`/`physton`) try providers in fallback "
        "order until one returns non-empty output. `mode='tags'` dedupes "
        "comma-separated tags and translates unique tokens through an on-disk "
        "cache. Returns `{translations: [...]}` (same length/order as `texts`) "
        "plus provider metadata; provider failures raise HTTP 502 with "
        "`{error, error_type, provider}` detail — there are no per-item error "
        "fields."
    ),
)
async def post_dataset_translate(payload: DatasetTranslateRequest) -> Dict[str, Any]:
    """Thin adapter: delegate to the dataset translation service.

    The translation subsystem (cache, provider alias maps, seven web
    provider clients, VLM bridge, auto-chain fallback) lives in
    ``services/dataset_translate_service``. This handler only normalizes
    the input texts and forwards them; all response-shape and
    error-shape decisions stay in the service.
    """
    texts = [str(text or "").strip() for text in payload.texts]
    return await translate_dataset_texts(payload, texts)


# ------------------------------ upload-files ------------------------------


@router.post(
    "/dataset/upload-files",
    summary="Upload image files directly into the Dataset Maker session",
    description=(
        "Accepts multipart file uploads, saves them to a temp directory, "
        "and returns the same item shape as folder-scan so the frontend "
        "can add them to the local-source queue."
    ),
    responses={
        200: {"description": "Upload succeeded — returns items[]"},
        400: {"description": "No valid image files uploaded"},
    },
)
async def post_dataset_upload_files(
    files: List[UploadFile] = File(...),
    recursive: bool = Form(True),
) -> Dict[str, Any]:
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded.")
    try:
        return await upload_files_for_dataset(files, recursive=recursive)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Dataset upload-files failed")
        raise HTTPException(
            status_code=500,
            detail="Upload failed. / 上传失败。",
        ) from exc
