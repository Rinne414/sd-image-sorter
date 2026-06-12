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
import importlib
import json
import os
import threading
import asyncio
from datetime import datetime, timezone
from email.utils import format_datetime
from itertools import chain
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field

from config import DEFAULT_CACHE_DIR
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
    iter_scan_manifest_paths,
    resolve_paths_for_dataset,
    scan_folder_for_dataset,
    upload_files_for_dataset,
)
from thumbnail_cache import generate_placeholder_thumbnail, get_thumbnail_async


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
            detail="Dataset export failed. / 資料集匯出失敗。",
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
            detail="Dataset export preview failed. / 資料集匯出預覽失敗。",
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
            detail="Dataset export start failed. / 資料集匯出啟動失敗。",
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
            detail="Dataset export progress failed. / 取得匯出進度失敗。",
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
            detail="Dataset export cancel failed. / 取消匯出失敗。",
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
            detail="Folder scan failed. / 資料夾掃描失敗。",
        ) from exc


@router.get(
    "/dataset/local-thumbnail",
    summary="Get a thumbnail for a Dataset Maker local-source path",
    responses={
        200: {"description": "Thumbnail image (WebP format)"},
        404: {"description": "Image path is not readable"},
    },
)
async def get_dataset_local_thumbnail(
    path: str = Query(..., min_length=1, max_length=4096),
    size: int = Query(default=256, ge=1, le=4096),
) -> StreamingResponse:
    resolved = resolve_paths_for_dataset([path])
    if not resolved:
        raise HTTPException(status_code=404, detail="Image path is not readable")

    source_path = resolved[0]
    if os.path.islink(source_path):
        raise HTTPException(status_code=404, detail="Image path is not readable")

    try:
        if int(size) > 512:
            with Image.open(source_path) as img:
                resample = getattr(Image, "Resampling", Image).LANCZOS
                working = img.convert("RGB") if img.mode not in ("RGB", "L") else img.copy()
                working.thumbnail((int(size), int(size)), resample)
                buf = io.BytesIO()
                working.save(buf, format="WEBP", quality=92, method=4)
            stat = os.stat(source_path)
            return StreamingResponse(
                io.BytesIO(buf.getvalue()),
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
            detail="Audit failed. / 資料集稽核失敗。",
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


# ------------------------------ translate ------------------------------

_TRANSLATION_CACHE_LOCK = threading.Lock()
_TRANSLATION_CACHE: Optional[Dict[str, str]] = None
_TRANSLATION_CACHE_MAX_ITEMS = 50_000
_DIRECT_TRANSLATION_PROVIDER_ALIASES = {
    "google": "google",
    "google_free": "google",
    "googlefree": "google",
    "mymemory": "mymemory",
    "my_memory": "mymemory",
    "mymemory_free": "mymemory",
    "mymemoryfree": "mymemory",
    "baidu": "baidu",
    "baidu_sug": "baidu",
    "baidu_tag": "baidu",
}
_TRANSLATORS_PROVIDER_ALIASES = {
    "bing_free": "bing",
    "bing_web": "bing",
    "bing-free": "bing",
    "bingfree": "bing",
    "itranslate_free": "itranslate",
    "itranslate": "itranslate",
    "lingvanex_free": "lingvanex",
    "lingvanex": "lingvanex",
    "modernmt_free": "modernMt",
    "modernmt": "modernMt",
    "modern_mt": "modernMt",
    "systran_free": "sysTran",
    "systran": "sysTran",
    "sys_tran": "sysTran",
    "translatecom_free": "translateCom",
    "translatecom": "translateCom",
    "translate_com": "translateCom",
    "argos_free": "argos",
    "argos": "argos",
    "papago_free": "papago",
    "papago": "papago",
    "reverso_free": "reverso",
    "reverso": "reverso",
    "translateme_free": "translateMe",
    "translateme": "translateMe",
    "translate_me": "translateMe",
    "elia_free": "elia",
    "elia": "elia",
    "judic_free": "judic",
    "judic": "judic",
    "alibaba_free": "alibaba",
    "alibabafree": "alibaba",
    "alibaba_web": "alibaba",
    "alibaba": "alibaba",
    "baidu_free": "baidu",
    "baidu_web": "baidu",
    "baiduweb": "baidu",
    "sogou_free": "sogou",
    "sogou": "sogou",
    "qqtransmart_free": "qqTranSmart",
    "qqtransmart": "qqTranSmart",
    "qq_tran_smart": "qqTranSmart",
    "qqfanyi": "qqFanyi",
    "qq_fanyi": "qqFanyi",
    "youdao_free": "youdao",
    "youdao": "youdao",
    "iciba_free": "iciba",
    "iciba": "iciba",
    "cloudyi_free": "cloudTranslation",
    "cloudyi": "cloudTranslation",
    "cloudyifree": "cloudTranslation",
    "cloudtranslation_free": "cloudTranslation",
    "cloudtranslation": "cloudTranslation",
    "cloud_translation": "cloudTranslation",
    "caiyun_free": "caiyun",
    "caiyun": "caiyun",
    "mymemory_web": "myMemory",
    "mymemoryweb": "myMemory",
}
_MAINLAND_FREE_PROVIDER_CHAIN = [
    "baidu_free",
    "alibaba_free",
    "sogou_free",
    "youdao_free",
    "iciba_free",
    "qqtransmart_free",
    "caiyun_free",
    "cloudyi_free",
    "bing_free",
    "mymemory_free",
    "google_free",
    "baidu",
]
_GLOBAL_FREE_PROVIDER_CHAIN = [
    "google_free",
    "mymemory_free",
    "bing_free",
    "itranslate_free",
    "lingvanex_free",
    "modernmt_free",
    "systran_free",
    "translatecom_free",
    "argos_free",
    "papago_free",
    "reverso_free",
    "translateme_free",
    "elia_free",
    "judic_free",
    "alibaba_free",
    "baidu_free",
    "sogou_free",
    "qqtransmart_free",
    "youdao_free",
    "iciba_free",
    "cloudyi_free",
    "caiyun_free",
    "baidu",
]

class DatasetTranslateRequest(BaseModel):
    """Translate Dataset Maker tags/captions for review.

    Translation output is advisory only. The frontend must not write the
    translation back into training captions unless the user explicitly asks.
    """

    model_config = ConfigDict(extra="ignore")

    texts: List[str] = Field(default_factory=list, max_length=200)
    mode: str = Field(default="tags", max_length=24)
    target_lang: str = Field(default="zh-CN", max_length=24)
    provider_mode: str = Field(default="vlm", max_length=24)
    prompt: Optional[str] = Field(default=None, max_length=4000)
    external_provider: Optional[str] = Field(default=None, max_length=64)
    source_lang: str = Field(default="en", max_length=24)


def _parse_translation_output(raw_text: str, expected_count: int) -> List[str]:
    text = str(raw_text or "").strip()
    if not text:
        return [""] * expected_count
    if text.startswith("```"):
        text = text.strip("`")
        if "\n" in text:
            text = text.split("\n", 1)[1].strip()
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            parsed = parsed.get("translations") or parsed.get("items") or []
        if isinstance(parsed, list):
            out = [str(item or "").strip() for item in parsed]
            return (out + [""] * expected_count)[:expected_count]
    except Exception:
        pass
    lines = [
        line.strip().lstrip("-*0123456789.、) ")
        for line in text.splitlines()
        if line.strip()
    ]
    if len(lines) == expected_count:
        return lines
    return [text] + [""] * max(0, expected_count - 1)


def _translation_cache_path() -> Path:
    path = Path(DEFAULT_CACHE_DIR) / "dataset-translation-cache.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _load_translation_cache() -> Dict[str, str]:
    global _TRANSLATION_CACHE
    with _TRANSLATION_CACHE_LOCK:
        if _TRANSLATION_CACHE is not None:
            return _TRANSLATION_CACHE
        path = _translation_cache_path()
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            _TRANSLATION_CACHE = {
                str(k): str(v)
                for k, v in (raw.items() if isinstance(raw, dict) else [])
                if str(k) and str(v)
            }
        except Exception:
            _TRANSLATION_CACHE = {}
        return _TRANSLATION_CACHE


def _save_translation_cache() -> None:
    with _TRANSLATION_CACHE_LOCK:
        cache = _TRANSLATION_CACHE or {}
        if len(cache) > _TRANSLATION_CACHE_MAX_ITEMS:
            keep = list(cache.items())[-_TRANSLATION_CACHE_MAX_ITEMS:]
            cache.clear()
            cache.update(keep)
        path = _translation_cache_path()
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(cache, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        tmp.replace(path)


def _translation_cache_key(
    provider: str,
    *,
    source_lang: str,
    target_lang: str,
    mode: str,
    text: str,
) -> str:
    normalized = " ".join(str(text or "").strip().split())
    return json.dumps(
        [
            "dataset-translate-v1",
            str(provider or "auto").lower(),
            str(source_lang or "en").lower(),
            str(target_lang or "zh-CN").lower(),
            str(mode or "caption").lower(),
            normalized,
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _translation_lang_code(lang: str, *, provider: str) -> str:
    value = str(lang or "zh-CN").strip()
    if provider == "bing" and value.lower() in {"zh-cn", "zh-hans", "cn"}:
        return "zh-Hans"
    if provider == "google" and value.lower() in {"zh-hans", "zh_cn", "cn"}:
        return "zh-CN"
    if provider == "baidu" and value.lower() in {"zh-cn", "zh-hans", "zh_cn", "cn"}:
        return "zh"
    return value


def _translation_source_lang(lang: str) -> str:
    value = str(lang or "en").strip()
    return value if value and value.lower() != "auto" else "en"


async def _translate_google_free(
    texts: List[str],
    *,
    source_lang: str,
    target_lang: str,
) -> List[str]:
    out: List[str] = []
    headers = {"User-Agent": "Mozilla/5.0 SD-Image-Sorter Dataset Maker"}
    async with httpx.AsyncClient(timeout=12.0, headers=headers) as client:
        for text in texts:
            if not text:
                out.append("")
                continue
            response = await client.get(
                "https://translate.googleapis.com/translate_a/single",
                params={
                    "client": "gtx",
                    "sl": source_lang or "auto",
                    "tl": _translation_lang_code(target_lang, provider="google"),
                    "dt": "t",
                    "q": text,
                },
            )
            response.raise_for_status()
            data = response.json()
            segments = data[0] if isinstance(data, list) and data else []
            translated = "".join(
                str(seg[0] or "")
                for seg in segments
                if isinstance(seg, list) and seg
            ).strip()
            out.append(translated)
    return out


async def _translate_mymemory_free(
    texts: List[str],
    *,
    source_lang: str,
    target_lang: str,
) -> List[str]:
    out: List[str] = []
    langpair = f"{_translation_source_lang(source_lang)}|{_translation_lang_code(target_lang, provider='mymemory')}"
    headers = {"User-Agent": "Mozilla/5.0 SD-Image-Sorter Dataset Maker"}
    async with httpx.AsyncClient(timeout=12.0, headers=headers) as client:
        for text in texts:
            if not text:
                out.append("")
                continue
            response = await client.get(
                "https://api.mymemory.translated.net/get",
                params={"q": text, "langpair": langpair},
            )
            response.raise_for_status()
            data = response.json()
            if int(data.get("responseStatus") or 0) >= 400:
                raise RuntimeError(str(data.get("responseDetails") or "MyMemory translation failed"))
            out.append(str((data.get("responseData") or {}).get("translatedText") or "").strip())
    return out


def _split_caption_tags(text: str) -> List[str]:
    return [token.strip() for token in str(text or "").split(",") if token.strip()]


def _looks_like_tag_list(text: str) -> bool:
    value = str(text or "")
    return "," in value or "_" in value or len(value.split()) <= 5


def _translate_mode_for_texts(mode: str, texts: List[str]) -> str:
    requested = str(mode or "").lower()
    if requested == "tags":
        return "tags"
    # Dataset captions are often comma-separated tag captions even when the
    # UI calls the button from a generic caption row. Treat those as tags so
    # we can dedupe/cache each token instead of spending quota on whole lines.
    if texts and all(_looks_like_tag_list(text) for text in texts):
        return "tags"
    return "caption"


async def _translate_external_uncached(
    provider: str,
    texts: List[str],
    *,
    source_lang: str,
    target_lang: str,
    mode: str,
) -> Dict[str, Any]:
    provider = str(provider or "").strip().lower()
    direct_provider = _DIRECT_TRANSLATION_PROVIDER_ALIASES.get(provider)
    if direct_provider == "google":
        translations = await _translate_google_free(texts, source_lang=source_lang, target_lang=target_lang)
        provider_name = "google"
    elif direct_provider == "mymemory":
        translations = await _translate_mymemory_free(texts, source_lang=source_lang, target_lang=target_lang)
        provider_name = "mymemory"
    elif direct_provider == "baidu":
        translations = await _translate_baidu_sug_free(texts, mode=mode)
        provider_name = "baidu"
    elif provider in _TRANSLATORS_PROVIDER_ALIASES:
        translations = await _translate_translators_web(
            provider,
            texts,
            source_lang=source_lang,
            target_lang=target_lang,
        )
        provider_name = _TRANSLATORS_PROVIDER_ALIASES.get(provider, provider)
    elif provider == "bing":
        translations = await _translate_bing_keyed(texts, source_lang=source_lang, target_lang=target_lang)
        provider_name = "bing"
    elif provider == "custom":
        translations = await _translate_custom_external(
            texts,
            source_lang=source_lang,
            target_lang=target_lang,
            mode=mode,
        )
        provider_name = "custom"
    else:
        raise RuntimeError(f"Unknown external translation provider: {provider}")
    return {
        "translations": (translations + [""] * len(texts))[:len(texts)],
        "provider": provider_name,
    }


async def _translate_external_with_cache(
    provider: str,
    texts: List[str],
    *,
    source_lang: str,
    target_lang: str,
    mode: str,
) -> Dict[str, Any]:
    cache = _load_translation_cache()
    keys = [
        _translation_cache_key(provider, source_lang=source_lang, target_lang=target_lang, mode=mode, text=text)
        for text in texts
    ]
    out: List[Optional[str]] = [cache.get(key) for key in keys]
    missing_index_by_text: Dict[str, List[int]] = {}
    for idx, value in enumerate(out):
        if value is None:
            missing_index_by_text.setdefault(texts[idx], []).append(idx)
    if missing_index_by_text:
        missing_texts = list(missing_index_by_text.keys())
        translated = await _translate_external_uncached(
            provider,
            missing_texts,
            source_lang=source_lang,
            target_lang=target_lang,
            mode=mode,
        )
        provider_name = str(translated.get("provider") or provider)
        changed = False
        for text, translation in zip(missing_texts, translated.get("translations") or []):
            for idx in missing_index_by_text.get(text, []):
                value = str(translation or "").strip()
                out[idx] = value
                if value:
                    cache[keys[idx]] = value
                    changed = True
        if changed:
            _save_translation_cache()
    else:
        provider_name = provider
    return {
        "translations": [str(item or "") for item in out],
        "provider": provider_name,
        "cache_hits": len(texts) - len(missing_index_by_text),
        "cache_misses": len(missing_index_by_text),
    }


async def _translate_tag_texts_smart(
    provider: str,
    texts: List[str],
    *,
    source_lang: str,
    target_lang: str,
) -> Dict[str, Any]:
    token_order: List[str] = []
    seen_tokens: set[str] = set()
    tokenized: List[List[str]] = []
    for text in texts:
        tokens = _split_caption_tags(text)
        tokenized.append(tokens)
        for token in tokens:
            key = token.lower()
            if key in seen_tokens:
                continue
            seen_tokens.add(key)
            token_order.append(token)
    if not token_order:
        return {"translations": [""] * len(texts), "provider": provider, "cache_hits": 0, "cache_misses": 0, "unique_terms": 0}
    translated = await _translate_external_with_cache(
        provider,
        token_order,
        source_lang=source_lang,
        target_lang=target_lang,
        mode="tag",
    )
    if not any(str(item or "").strip() for item in translated.get("translations") or []):
        raise RuntimeError(f"{provider} returned empty tag translations")
    by_lower = {
        source.lower(): target
        for source, target in zip(token_order, translated.get("translations") or [])
    }
    return {
        "translations": [
            ", ".join(by_lower.get(token.lower(), token) or token for token in tokens)
            for tokens in tokenized
        ],
        "provider": translated.get("provider") or provider,
        "cache_hits": translated.get("cache_hits", 0),
        "cache_misses": translated.get("cache_misses", 0),
        "unique_terms": len(token_order),
    }


async def _translate_baidu_sug_free(
    texts: List[str],
    *,
    mode: str,
) -> List[str]:
    """Use Baidu's public suggestion endpoint as a weak no-key tag fallback.

    It is useful for short English tags but not a general sentence translator.
    """
    headers = {
        "User-Agent": "Mozilla/5.0 SD-Image-Sorter Dataset Maker",
        "Referer": "https://fanyi.baidu.com/",
    }
    async with httpx.AsyncClient(timeout=10.0, headers=headers) as client:
        async def one(term: str) -> str:
            response = await client.post("https://fanyi.baidu.com/sug", data={"kw": term})
            response.raise_for_status()
            data = response.json()
            items = data.get("data") if isinstance(data, dict) else []
            if not items:
                return ""
            value = str(items[0].get("v") or "").strip()
            return value.split(";")[0].split("；")[0].strip()

        out: List[str] = []
        for text in texts:
            if not text:
                out.append("")
                continue
            tokens = _split_caption_tags(text) if mode == "tags" or "," in text else [text.strip()]
            translated = []
            for token in tokens:
                translated.append(await one(token) or token)
            out.append(", ".join(translated) if "," in text or mode == "tags" else translated[0])
    return out


async def _translate_translators_web(
    provider: str,
    texts: List[str],
    *,
    source_lang: str,
    target_lang: str,
) -> List[str]:
    provider = str(provider or "").strip().lower()
    translator_name = _TRANSLATORS_PROVIDER_ALIASES.get(provider, provider)
    try:
        import translators as ts  # type: ignore[import-untyped]
    except Exception:  # noqa: BLE001
        try:
            from optional_dependencies import UnsafeDependencyInstallError, ensure_group
            install_result = ensure_group("translation")
            if install_result.installed_packages:
                importlib.invalidate_caches()
            import translators as ts  # type: ignore[import-untyped]
        except UnsafeDependencyInstallError as install_exc:
            raise RuntimeError(
                "The physton-style free web providers need the optional 'translators' runtime. "
                f"{install_exc}"
            ) from install_exc
        except Exception as install_exc:  # noqa: BLE001
            raise RuntimeError(
                "The physton-style free web providers need the optional 'translators' runtime, "
                "but automatic installation failed. Open Feature Setup/Prepare or run app setup again."
            ) from install_exc

    from_lang = str(source_lang or "auto").strip() or "auto"
    to_lang = _translation_lang_code(target_lang, provider=translator_name).strip() or "zh-CN"

    async def one(text: str) -> str:
        if not text:
            return ""

        def call(lang: str) -> str:
            return str(ts.translate_text(
                text,
                translator=translator_name,
                from_language=from_lang,
                to_language=lang,
                if_use_preacceleration=False,
                timeout=15,
            ) or "").strip()

        try:
            return await asyncio.to_thread(call, to_lang)
        except Exception as exc:  # noqa: BLE001
            if to_lang.lower() in {"zh-cn", "zh-hans"}:
                try:
                    return await asyncio.to_thread(call, "zh")
                except Exception as zh_exc:  # noqa: BLE001
                    logger.debug(
                        "Translate zh-fallback failed for target %s: %s",
                        to_lang,
                        zh_exc,
                    )
            raise exc

    return [await one(text) for text in texts]


async def _translate_bing_keyed(
    texts: List[str],
    *,
    source_lang: str,
    target_lang: str,
) -> List[str]:
    key = os.environ.get("SD_IMAGE_SORTER_TRANSLATE_BING_KEY", "").strip()
    region = os.environ.get("SD_IMAGE_SORTER_TRANSLATE_BING_REGION", "").strip()
    if not key:
        raise RuntimeError(
            "Bing free/no-key endpoint rejected this runtime. Use Auto/Google/MyMemory, "
            "or set SD_IMAGE_SORTER_TRANSLATE_BING_KEY for Microsoft Translator."
        )
    headers = {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/json",
    }
    if region:
        headers["Ocp-Apim-Subscription-Region"] = region
    params = {
        "api-version": "3.0",
        "from": _translation_source_lang(source_lang),
        "to": _translation_lang_code(target_lang, provider="bing"),
    }
    async with httpx.AsyncClient(timeout=15.0, headers=headers) as client:
        response = await client.post(
            "https://api.cognitive.microsofttranslator.com/translate",
            params=params,
            json=[{"Text": text} for text in texts],
        )
        response.raise_for_status()
        data = response.json()
    return [
        str((((item.get("translations") or [{}])[0]).get("text") or "")).strip()
        for item in data
    ]


async def _translate_custom_external(
    texts: List[str],
    *,
    source_lang: str,
    target_lang: str,
    mode: str,
) -> List[str]:
    url = os.environ.get("SD_IMAGE_SORTER_TRANSLATE_CUSTOM_URL", "").strip()
    if not url:
        raise RuntimeError("Set SD_IMAGE_SORTER_TRANSLATE_CUSTOM_URL to use the custom translation provider.")
    headers = {"Content-Type": "application/json"}
    api_key = os.environ.get("SD_IMAGE_SORTER_TRANSLATE_CUSTOM_KEY", "").strip()
    header_name = os.environ.get("SD_IMAGE_SORTER_TRANSLATE_CUSTOM_KEY_HEADER", "Authorization").strip() or "Authorization"
    if api_key:
        headers[header_name] = api_key if header_name.lower() != "authorization" else f"Bearer {api_key}"
    async with httpx.AsyncClient(timeout=20.0, headers=headers) as client:
        response = await client.post(
            url,
            json={
                "texts": texts,
                "source_lang": source_lang,
                "target_lang": target_lang,
                "mode": mode,
            },
        )
        response.raise_for_status()
        data = response.json()
    parsed = data.get("translations") or data.get("items") if isinstance(data, dict) else data
    if not isinstance(parsed, list):
        raise RuntimeError("Custom translation response must be a JSON list or {translations: [...]}.")
    return [str(item or "").strip() for item in parsed][:len(texts)]


async def _translate_external_texts(payload: DatasetTranslateRequest, texts: List[str]) -> Dict[str, Any]:
    provider = str(payload.external_provider or "auto").strip().lower()
    mode = _translate_mode_for_texts(payload.mode, texts)
    source_lang = str(payload.source_lang or "en").strip() or "en"
    target_lang = str(payload.target_lang or "zh-CN").strip() or "zh-CN"
    attempts = [provider]
    if provider in {"", "auto", "free", "auto_global"}:
        attempts = _GLOBAL_FREE_PROVIDER_CHAIN
    elif provider in {"auto_cn", "mainland", "china", "physton"}:
        attempts = _MAINLAND_FREE_PROVIDER_CHAIN

    errors: List[str] = []
    for name in attempts:
        try:
            if mode == "tags":
                translated = await _translate_tag_texts_smart(
                    name,
                    texts,
                    source_lang=source_lang,
                    target_lang=target_lang,
                )
            else:
                translated = await _translate_external_with_cache(
                    name,
                    texts,
                    source_lang=source_lang,
                    target_lang=target_lang,
                    mode=mode,
                )
                if any(texts) and not any(str(item or "").strip() for item in translated.get("translations") or []):
                    raise RuntimeError(f"{name} returned empty translations")
            return {
                "translations": (translated.get("translations", []) + [""] * len(texts))[:len(texts)],
                "provider_mode": "external",
                "provider": translated.get("provider") or name,
                "target_lang": target_lang,
                "source_lang": source_lang,
                "mode": mode,
                "cache_hits": translated.get("cache_hits", 0),
                "cache_misses": translated.get("cache_misses", 0),
                "unique_terms": translated.get("unique_terms", len(texts)),
            }
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{name}: {exc}")
            if provider not in {"", "auto", "free", "auto_global", "auto_cn", "mainland", "china", "physton"}:
                break

    raise HTTPException(status_code=502, detail={
        "error": "; ".join(errors) or "External translation failed",
        "error_type": "external_provider_error",
        "provider": provider or "auto",
    })


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
    """Translate Dataset Maker texts via the configured VLM or free web providers.

    Response contract:
    - Always: ``translations`` — list aligned 1:1 with ``payload.texts``.
    - VLM mode adds ``provider_mode='vlm'``, ``provider``, ``model``,
      ``tokens_used``.
    - External mode adds ``provider_mode='external'``, ``provider`` (the one
      that actually succeeded), ``source_lang``, ``target_lang``, ``mode``,
      ``cache_hits``, ``cache_misses``, ``unique_terms``.
    - Errors: 400 when VLM mode has no endpoint configured; 502 with
      ``{error, error_type, provider}`` detail when the provider (or every
      provider in an auto chain) fails or returns empty output.
    """
    texts = [str(text or "").strip() for text in payload.texts]
    if not texts:
        return {"translations": [], "provider_mode": payload.provider_mode}

    provider_mode = str(payload.provider_mode or "vlm").strip().lower()
    if provider_mode != "vlm":
        return await _translate_external_texts(payload, texts)

    from routers.vlm import _build_config
    from vlm_providers import get_provider

    config = _build_config()
    if not config.endpoint and not config.use_vertex:
        raise HTTPException(status_code=400, detail="No VLM endpoint configured for translation")

    mode = "tags" if str(payload.mode or "").lower() == "tags" else "caption"
    custom_prompt = str(payload.prompt or "").strip()
    system_prompt = (
        "You are a precise translation engine for Stable Diffusion dataset captions. "
        "Translate to Chinese. Preserve tag separators, order, counts, names, model tokens, "
        "and technical terms when translation would be harmful. Return only valid JSON."
    )
    instruction = custom_prompt or (
        "Translate each item to Simplified Chinese for human review. "
        "Return a JSON array of strings with exactly the same length as the input. "
        "For tag lists, keep comma-separated structure and translate understandable tag meanings; "
        "do not invent, remove, or reorder tags."
    )
    prompt = (
        f"Target language: {payload.target_lang}\n"
        f"Input mode: {mode}\n"
        f"{instruction}\n\n"
        f"Input JSON array:\n{json.dumps(texts, ensure_ascii=False)}"
    )
    provider = get_provider(config)
    result = await provider.generate_text(prompt, system_prompt=system_prompt, max_tokens=4096, temperature=0.1)
    if result.error:
        raise HTTPException(status_code=502, detail={
            "error": result.error,
            "error_type": result.error_type or "provider_error",
            "provider": config.provider,
            "model": config.model,
        })

    translations = _parse_translation_output(result.caption or result.raw_text, len(texts))
    if not any(str(item or "").strip() for item in translations):
        raise HTTPException(status_code=502, detail={
            "error": "Translation provider returned an empty translation",
            "error_type": "empty_response",
            "provider": config.provider,
            "model": config.model,
        })
    return {
        "translations": translations,
        "provider_mode": provider_mode,
        "provider": config.provider,
        "model": result.model or config.model,
        "tokens_used": result.tokens_used,
    }


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
            detail="Upload failed. / 上傳失敗。",
        ) from exc
