"""Mass tag editor router (v3.2.1).

Tag-Master inspired bulk tag operations on the DB. Operates persistently
on stored tags (separate from export-time substitution which happens in
the template engine).

Operations:
- Find & Replace: rename tag across N images
- Bulk Add: append tags to N images
- Bulk Remove: delete tags from N images
- Cleanup: remove tags below confidence threshold

All operations support dry-run preview before commit.
"""
from __future__ import annotations

import logging
import threading
from typing import Any, Dict, Iterator, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator

import database as db
from services.tag_export_service import (
    PROMPT_MATCH_MODE_CONTAINS,
    PROMPT_MATCH_MODE_EXACT,
    count_selection_token_ids,
    iter_selection_token_id_chunks,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/tags/bulk", tags=["tags-bulk"])
BULK_TAG_MAX_IMAGE_IDS = 1_000_000
BULK_TAG_ID_CHUNK_SIZE = 500
VALID_PROMPT_MATCH_MODES = {PROMPT_MATCH_MODE_EXACT, PROMPT_MATCH_MODE_CONTAINS}


_op_lock = threading.Lock()
_op_run_lock = threading.Lock()
_op_state: Dict[str, Any] = {
    "running": False,
    "operation": "",
    "total": 0,
    "completed": 0,
    "errors": [],
}


def _begin_op(name: str, total: int) -> None:
    """Mark a bulk op as started and reset progress counters.

    The separate run lock rejects overlapping operations before this
    state is reset. This lock only keeps counter mutations atomic for
    polling clients.
    """
    with _op_lock:
        _op_state.update({
            "running": True,
            "operation": name,
            "total": int(total),
            "completed": 0,
            "errors": [],
        })


def _bump_op_progress(delta: int = 1) -> None:
    with _op_lock:
        _op_state["completed"] = int(_op_state.get("completed") or 0) + int(delta)


def _record_op_error(image_id: int, message: str) -> None:
    with _op_lock:
        errors = _op_state.setdefault("errors", [])
        if len(errors) < 50:
            errors.append({"image_id": image_id, "error": message})


def _end_op() -> None:
    with _op_lock:
        _op_state["running"] = False


def _run_exclusive(operation: str, handler, request) -> Dict[str, Any]:
    """Run one bulk operation at a time to avoid read-modify-write tag loss."""
    if not _op_run_lock.acquire(blocking=False):
        raise HTTPException(
            status_code=409,
            detail="Another bulk tag operation is already running. Wait for it to finish.",
        )
    try:
        return handler(request)
    finally:
        _op_run_lock.release()


# ====================================================================
# Request models
# ====================================================================

class BulkTagFilterContract(BaseModel):
    generators: List[str] = Field(default_factory=list)
    tags: List[str] = Field(default_factory=list)
    tagMode: str = Field(default="and", pattern="^(and|or)$")
    ratings: List[str] = Field(default_factory=list)
    checkpoints: List[str] = Field(default_factory=list)
    loras: List[str] = Field(default_factory=list)
    prompts: List[str] = Field(default_factory=list)
    promptMatchMode: str = PROMPT_MATCH_MODE_EXACT
    artist: Optional[str] = None
    search: str = ""
    sortBy: str = "newest"
    minWidth: Optional[int] = Field(default=None, ge=1, le=100000)
    maxWidth: Optional[int] = Field(default=None, ge=1, le=100000)
    minHeight: Optional[int] = Field(default=None, ge=1, le=100000)
    maxHeight: Optional[int] = Field(default=None, ge=1, le=100000)
    aspectRatio: Optional[str] = None
    minAesthetic: Optional[float] = Field(default=None, ge=0, le=10)
    maxAesthetic: Optional[float] = Field(default=None, ge=0, le=10)
    brightnessMin: Optional[float] = Field(default=None, ge=0, le=255)
    brightnessMax: Optional[float] = Field(default=None, ge=0, le=255)
    colorTemperature: Optional[str] = Field(default=None, pattern="^(warm|cool|neutral)$")
    brightnessDistribution: Optional[str] = Field(
        default=None,
        pattern="^(left_heavy|right_heavy|middle_heavy|edge_heavy|balanced)$",
    )
    excludedImageIds: List[int] = Field(default_factory=list, max_length=10000)
    excludeTags: List[str] = Field(default_factory=list)
    excludeGenerators: List[str] = Field(default_factory=list)
    excludeRatings: List[str] = Field(default_factory=list)
    excludeCheckpoints: List[str] = Field(default_factory=list)
    excludeLoras: List[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def normalize_contract(self) -> "BulkTagFilterContract":
        prompt_mode = str(self.promptMatchMode or PROMPT_MATCH_MODE_EXACT).strip().lower()
        if prompt_mode not in VALID_PROMPT_MATCH_MODES:
            raise ValueError("promptMatchMode must be exact or contains")
        self.promptMatchMode = prompt_mode
        self.tagMode = "or" if str(self.tagMode or "and").strip().lower() == "or" else "and"

        sort_by = str(self.sortBy or "newest").strip()
        if sort_by not in db.VALID_SORT_OPTIONS:
            raise ValueError("Invalid sortBy value")
        if sort_by == "random":
            raise ValueError("random sort cannot use bulk tag filter scope")
        self.sortBy = sort_by

        if self.aspectRatio == "":
            self.aspectRatio = None
        return self


class BulkTagScopeRequest(BaseModel):
    image_ids: Optional[List[int]] = Field(default=None, min_length=1, max_length=BULK_TAG_MAX_IMAGE_IDS)
    selection_token: Optional[str] = Field(default=None, min_length=1)
    filters: Optional[BulkTagFilterContract] = None

    @model_validator(mode="after")
    def require_one_scope(self) -> "BulkTagScopeRequest":
        scope_count = sum([
            self.image_ids is not None,
            bool(self.selection_token),
            self.filters is not None,
        ])
        if scope_count == 0:
            raise ValueError("One of image_ids, selection_token, or filters is required")
        if scope_count > 1:
            raise ValueError("Provide only one of image_ids, selection_token, or filters")
        return self


class FindReplaceRequest(BulkTagScopeRequest):
    find: str
    replace: str
    case_sensitive: bool = False
    dry_run: bool = False


class BulkAddRequest(BulkTagScopeRequest):
    tags: List[str] = Field(min_length=1, max_length=200)
    confidence: float = 0.85
    dry_run: bool = False


class BulkRemoveRequest(BulkTagScopeRequest):
    tags: List[str] = Field(min_length=1, max_length=200)
    case_sensitive: bool = False
    dry_run: bool = False


class CleanupRequest(BulkTagScopeRequest):
    # v3.2.2: confidence is normalized to [0.0, 1.0]. Out-of-range
    # values (e.g. 1.5) used to silently mean "remove all tags",
    # which is destructive when dry_run=False. Negative values were
    # silent no-ops. Bound them so the caller has to be explicit.
    min_confidence: float = Field(default=0.20, ge=0.0, le=1.0)
    dedupe: bool = True
    dry_run: bool = False


# ====================================================================
# Endpoints
# ====================================================================

@router.post("/find-replace")
def find_replace(request: FindReplaceRequest):
    """Bulk find & replace a tag across multiple images.

    Returns dry-run preview if dry_run=True, otherwise commits.
    """
    return _run_exclusive("find_replace", _do_find_replace, request)


@router.post("/add")
def bulk_add(request: BulkAddRequest):
    """Append tags to multiple images (dedupe against existing tags).

    Tags added with the specified confidence (default 0.85 = manual tier).
    """
    return _run_exclusive("bulk_add", _do_bulk_add, request)


@router.post("/remove")
def bulk_remove(request: BulkRemoveRequest):
    """Remove specified tags from multiple images."""
    return _run_exclusive("bulk_remove", _do_bulk_remove, request)


@router.post("/cleanup")
def cleanup(request: CleanupRequest):
    """Remove tags below confidence threshold and optionally dedupe."""
    return _run_exclusive("cleanup", _do_cleanup, request)


@router.get("/state")
async def get_state():
    """Get current bulk operation state (for progress display)."""
    with _op_lock:
        return dict(_op_state)


# ====================================================================
# Scope helpers
# ====================================================================

def _list_or_none(values: Optional[List[Any]]) -> Optional[List[Any]]:
    return values or None


def _iter_explicit_id_chunks(image_ids: List[int]) -> Iterator[List[int]]:
    chunk_size = max(1, int(BULK_TAG_ID_CHUNK_SIZE or 500))
    for start in range(0, len(image_ids), chunk_size):
        yield image_ids[start:start + chunk_size]


def _filter_contract_db_kwargs(filters: BulkTagFilterContract) -> Dict[str, Any]:
    return {
        "generators": _list_or_none(filters.generators),
        "tags": _list_or_none(filters.tags),
        "tag_mode": filters.tagMode,
        "ratings": _list_or_none(filters.ratings),
        "checkpoints": _list_or_none(filters.checkpoints),
        "loras": _list_or_none(filters.loras),
        "search_query": filters.search or None,
        "min_width": filters.minWidth,
        "max_width": filters.maxWidth,
        "min_height": filters.minHeight,
        "max_height": filters.maxHeight,
        "prompt_terms": _list_or_none(filters.prompts),
        "prompt_match_mode": filters.promptMatchMode,
        "aspect_ratio": filters.aspectRatio,
        "artist": filters.artist,
        "excluded_image_ids": _list_or_none(filters.excludedImageIds),
        "min_aesthetic": filters.minAesthetic,
        "max_aesthetic": filters.maxAesthetic,
        "brightness_min": filters.brightnessMin,
        "brightness_max": filters.brightnessMax,
        "color_temperature": filters.colorTemperature,
        "brightness_distribution": filters.brightnessDistribution,
        "exclude_tags": _list_or_none(filters.excludeTags),
        "exclude_generators": _list_or_none(filters.excludeGenerators),
        "exclude_ratings": _list_or_none(filters.excludeRatings),
        "exclude_checkpoints": _list_or_none(filters.excludeCheckpoints),
        "exclude_loras": _list_or_none(filters.excludeLoras),
    }


def _iter_filter_contract_id_chunks(filters: BulkTagFilterContract) -> Iterator[List[int]]:
    yield from db.iter_filtered_image_id_chunks(
        chunk_size=BULK_TAG_ID_CHUNK_SIZE,
        sort_by=filters.sortBy,
        **_filter_contract_db_kwargs(filters),
    )


def _iter_scope_id_chunks(request: BulkTagScopeRequest) -> Iterator[List[int]]:
    if request.image_ids is not None:
        yield from _iter_explicit_id_chunks(request.image_ids)
        return
    if request.selection_token:
        yield from iter_selection_token_id_chunks(
            request.selection_token,
            chunk_size=BULK_TAG_ID_CHUNK_SIZE,
        )
        return
    if request.filters is not None:
        yield from _iter_filter_contract_id_chunks(request.filters)


def _estimate_scope_total(request: BulkTagScopeRequest) -> int:
    if request.image_ids is not None:
        return len(request.image_ids)
    if request.selection_token:
        return int(count_selection_token_ids(request.selection_token))
    if request.filters is not None:
        return int(db.get_filtered_image_count(**_filter_contract_db_kwargs(request.filters)))
    return 0


def _scope_source(request: BulkTagScopeRequest) -> str:
    if request.image_ids is not None:
        return "image_ids"
    if request.selection_token:
        return "selection_token"
    return "filters"


def _commit_tag_updates(updates: List[Dict[str, Any]]) -> None:
    if not updates:
        return
    try:
        db.add_tags_batch(updates)
        return
    except Exception as exc:  # pragma: no cover - defensive fallback
        logger.warning("bulk tag batch commit failed; retrying per image: %s", exc)

    for item in updates:
        image_id = int(item.get("image_id") or 0)
        try:
            db.add_tags(image_id, item.get("tags") or [])
        except Exception as exc:  # pragma: no cover - defensive fallback
            logger.warning("bulk tag commit failed for image %s: %s", image_id, exc)
            _record_op_error(image_id, str(exc))


# ====================================================================
# Implementations
# ====================================================================

def _do_find_replace(request: FindReplaceRequest) -> Dict[str, Any]:
    find = request.find.strip()
    replace = request.replace.strip()
    if not find:
        raise HTTPException(400, "find string cannot be empty")

    if request.case_sensitive:
        match_fn = lambda tag: tag == find
    else:
        find_lower = find.lower()
        match_fn = lambda tag: tag.lower() == find_lower

    total_estimate = _estimate_scope_total(request)
    total_checked = 0
    affected_images = 0
    affected_tags = 0
    sample_changes: List[Dict[str, Any]] = []

    _begin_op("find_replace", total_estimate)
    try:
        for image_ids in _iter_scope_id_chunks(request):
            tags_by_image = db.get_image_tags_map(image_ids)
            updates: List[Dict[str, Any]] = []
            for image_id in image_ids:
                try:
                    existing = tags_by_image.get(image_id) or []
                    if not existing:
                        continue
                    new_tags = []
                    modified = False
                    for t in existing:
                        tag_str = str(t.get("tag") or "")
                        if match_fn(tag_str):
                            affected_tags += 1
                            modified = True
                            if replace:  # replace with new tag
                                new_tags.append({"tag": replace, "confidence": float(t.get("confidence") or 1.0)})
                            # else: drop the tag (replace="" means remove)
                        else:
                            new_tags.append({"tag": tag_str, "confidence": float(t.get("confidence") or 1.0)})

                    if modified:
                        affected_images += 1
                        if len(sample_changes) < 5:
                            sample_changes.append({
                                "image_id": image_id,
                                "before": [t.get("tag") for t in existing],
                                "after": [t.get("tag") for t in new_tags],
                            })
                        if not request.dry_run:
                            # Dedupe by tag name (case-insensitive)
                            seen = set()
                            deduped = []
                            for t in new_tags:
                                key = t["tag"].lower()
                                if key not in seen:
                                    seen.add(key)
                                    deduped.append(t)
                            updates.append({"image_id": image_id, "tags": deduped})
                except Exception as exc:  # pragma: no cover — defensive
                    logger.warning("find_replace failed for image %s: %s", image_id, exc)
                    _record_op_error(image_id, str(exc))
                finally:
                    total_checked += 1
                    _bump_op_progress()
            if not request.dry_run:
                _commit_tag_updates(updates)
    finally:
        _end_op()

    return {
        "operation": "find_replace",
        "dry_run": request.dry_run,
        "scope_source": _scope_source(request),
        "total_images_checked": total_checked,
        "total_images_estimate": total_estimate,
        "affected_images": affected_images,
        "affected_tags": affected_tags,
        "sample_changes": sample_changes,
        "find": find,
        "replace": replace,
    }


def _do_bulk_add(request: BulkAddRequest) -> Dict[str, Any]:
    add_tags = [t.strip() for t in request.tags if t and t.strip()]
    if not add_tags:
        raise HTTPException(400, "tags list cannot be empty")

    confidence = float(max(0.0, min(1.0, request.confidence)))

    total_estimate = _estimate_scope_total(request)
    total_checked = 0
    affected_images = 0
    total_tags_added = 0
    sample_changes: List[Dict[str, Any]] = []

    _begin_op("bulk_add", total_estimate)
    try:
        for image_ids in _iter_scope_id_chunks(request):
            tags_by_image = db.get_image_tags_map(image_ids)
            updates: List[Dict[str, Any]] = []
            for image_id in image_ids:
                try:
                    existing = tags_by_image.get(image_id) or []
                    existing_lower = {(t.get("tag") or "").lower() for t in existing}

                    new_to_add = [t for t in add_tags if t.lower() not in existing_lower]
                    if not new_to_add:
                        continue

                    affected_images += 1
                    total_tags_added += len(new_to_add)

                    if len(sample_changes) < 5:
                        sample_changes.append({
                            "image_id": image_id,
                            "added": new_to_add,
                            "before_count": len(existing),
                            "after_count": len(existing) + len(new_to_add),
                        })

                    if not request.dry_run:
                        merged = [
                            {"tag": t.get("tag"), "confidence": float(t.get("confidence") or 1.0)}
                            for t in existing if t.get("tag")
                        ] + [
                            {"tag": t, "confidence": confidence} for t in new_to_add
                        ]
                        updates.append({"image_id": image_id, "tags": merged})
                except Exception as exc:  # pragma: no cover — defensive
                    logger.warning("bulk_add failed for image %s: %s", image_id, exc)
                    _record_op_error(image_id, str(exc))
                finally:
                    total_checked += 1
                    _bump_op_progress()
            if not request.dry_run:
                _commit_tag_updates(updates)
    finally:
        _end_op()

    return {
        "operation": "bulk_add",
        "dry_run": request.dry_run,
        "scope_source": _scope_source(request),
        "total_images_checked": total_checked,
        "total_images_estimate": total_estimate,
        "affected_images": affected_images,
        "total_tags_added": total_tags_added,
        "sample_changes": sample_changes,
        "tags_to_add": add_tags,
    }


def _do_bulk_remove(request: BulkRemoveRequest) -> Dict[str, Any]:
    remove_set = set()
    if request.case_sensitive:
        remove_set = {t.strip() for t in request.tags if t and t.strip()}
        match_fn = lambda tag: tag in remove_set
    else:
        remove_set = {t.strip().lower() for t in request.tags if t and t.strip()}
        match_fn = lambda tag: tag.lower() in remove_set

    if not remove_set:
        raise HTTPException(400, "tags list cannot be empty")

    total_estimate = _estimate_scope_total(request)
    total_checked = 0
    affected_images = 0
    total_tags_removed = 0
    sample_changes: List[Dict[str, Any]] = []

    _begin_op("bulk_remove", total_estimate)
    try:
        for image_ids in _iter_scope_id_chunks(request):
            tags_by_image = db.get_image_tags_map(image_ids)
            updates: List[Dict[str, Any]] = []
            for image_id in image_ids:
                try:
                    existing = tags_by_image.get(image_id) or []
                    if not existing:
                        continue

                    kept = []
                    removed_here = []
                    for t in existing:
                        tag_str = str(t.get("tag") or "")
                        if match_fn(tag_str):
                            removed_here.append(tag_str)
                        else:
                            kept.append({"tag": tag_str, "confidence": float(t.get("confidence") or 1.0)})

                    if removed_here:
                        affected_images += 1
                        total_tags_removed += len(removed_here)

                        if len(sample_changes) < 5:
                            sample_changes.append({
                                "image_id": image_id,
                                "removed": removed_here,
                                "remaining_count": len(kept),
                            })

                        if not request.dry_run:
                            updates.append({"image_id": image_id, "tags": kept})
                except Exception as exc:  # pragma: no cover — defensive
                    logger.warning("bulk_remove failed for image %s: %s", image_id, exc)
                    _record_op_error(image_id, str(exc))
                finally:
                    total_checked += 1
                    _bump_op_progress()
            if not request.dry_run:
                _commit_tag_updates(updates)
    finally:
        _end_op()

    return {
        "operation": "bulk_remove",
        "dry_run": request.dry_run,
        "scope_source": _scope_source(request),
        "total_images_checked": total_checked,
        "total_images_estimate": total_estimate,
        "affected_images": affected_images,
        "total_tags_removed": total_tags_removed,
        "sample_changes": sample_changes,
        "tags_to_remove": list(remove_set),
    }


def _do_cleanup(request: CleanupRequest) -> Dict[str, Any]:
    threshold = float(max(0.0, min(1.0, request.min_confidence)))

    total_estimate = _estimate_scope_total(request)
    total_checked = 0
    affected_images = 0
    total_low_conf = 0
    total_dupes = 0
    sample_changes: List[Dict[str, Any]] = []

    _begin_op("cleanup", total_estimate)
    try:
        for image_ids in _iter_scope_id_chunks(request):
            tags_by_image = db.get_image_tags_map(image_ids)
            updates: List[Dict[str, Any]] = []
            for image_id in image_ids:
                try:
                    existing = tags_by_image.get(image_id) or []
                    if not existing:
                        continue

                    # Drop low-confidence
                    filtered = [
                        t for t in existing
                        if float(t.get("confidence") or 1.0) >= threshold
                    ]
                    low_conf_count = len(existing) - len(filtered)

                    # Dedupe (case-insensitive, keep highest confidence)
                    dupe_count = 0
                    if request.dedupe:
                        best: Dict[str, Dict[str, Any]] = {}
                        for t in filtered:
                            key = (t.get("tag") or "").lower()
                            if not key:
                                continue
                            conf = float(t.get("confidence") or 1.0)
                            if key not in best or conf > float(best[key].get("confidence") or 1.0):
                                best[key] = t
                        dupe_count = len(filtered) - len(best)
                        cleaned = list(best.values())
                    else:
                        cleaned = filtered

                    if low_conf_count == 0 and dupe_count == 0:
                        continue

                    affected_images += 1
                    total_low_conf += low_conf_count
                    total_dupes += dupe_count

                    if len(sample_changes) < 5:
                        sample_changes.append({
                            "image_id": image_id,
                            "before_count": len(existing),
                            "after_count": len(cleaned),
                            "removed_low_conf": low_conf_count,
                            "removed_dupes": dupe_count,
                        })

                    if not request.dry_run:
                        normalized = [
                            {"tag": t.get("tag"), "confidence": float(t.get("confidence") or 1.0)}
                            for t in cleaned if t.get("tag")
                        ]
                        updates.append({"image_id": image_id, "tags": normalized})
                except Exception as exc:  # pragma: no cover — defensive
                    logger.warning("cleanup failed for image %s: %s", image_id, exc)
                    _record_op_error(image_id, str(exc))
                finally:
                    total_checked += 1
                    _bump_op_progress()
            if not request.dry_run:
                _commit_tag_updates(updates)
    finally:
        _end_op()

    return {
        "operation": "cleanup",
        "dry_run": request.dry_run,
        "scope_source": _scope_source(request),
        "total_images_checked": total_checked,
        "total_images_estimate": total_estimate,
        "affected_images": affected_images,
        "total_low_conf_removed": total_low_conf,
        "total_duplicates_removed": total_dupes,
        "sample_changes": sample_changes,
        "min_confidence": threshold,
        "dedupe": request.dedupe,
    }
