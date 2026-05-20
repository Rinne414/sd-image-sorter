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
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import database as db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/tags/bulk", tags=["tags-bulk"])


_op_lock = threading.Lock()
_op_state: Dict[str, Any] = {
    "running": False,
    "operation": "",
    "total": 0,
    "completed": 0,
    "errors": [],
}


def _begin_op(name: str, total: int) -> None:
    """Mark a bulk op as started and reset progress counters.

    The endpoints are synchronous so two clients calling concurrently is
    rare, but if it happens the second caller will see ``running=True``
    via ``GET /state`` and can choose to wait. We deliberately don't
    block here — that would deadlock the FastAPI worker for huge image
    lists. The lock is just used to keep counter mutations atomic for
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


# ====================================================================
# Request models
# ====================================================================

class FindReplaceRequest(BaseModel):
    image_ids: List[int] = Field(min_length=1, max_length=500000)
    find: str
    replace: str
    case_sensitive: bool = False
    dry_run: bool = False


class BulkAddRequest(BaseModel):
    image_ids: List[int] = Field(min_length=1, max_length=500000)
    tags: List[str] = Field(min_length=1, max_length=200)
    confidence: float = 0.85
    dry_run: bool = False


class BulkRemoveRequest(BaseModel):
    image_ids: List[int] = Field(min_length=1, max_length=500000)
    tags: List[str] = Field(min_length=1, max_length=200)
    case_sensitive: bool = False
    dry_run: bool = False


class CleanupRequest(BaseModel):
    image_ids: List[int] = Field(min_length=1, max_length=500000)
    min_confidence: float = 0.20
    dedupe: bool = True
    dry_run: bool = False


# ====================================================================
# Endpoints
# ====================================================================

@router.post("/find-replace")
async def find_replace(request: FindReplaceRequest):
    """Bulk find & replace a tag across multiple images.

    Returns dry-run preview if dry_run=True, otherwise commits.
    """
    return _do_find_replace(request)


@router.post("/add")
async def bulk_add(request: BulkAddRequest):
    """Append tags to multiple images (dedupe against existing tags).

    Tags added with the specified confidence (default 0.85 = manual tier).
    """
    return _do_bulk_add(request)


@router.post("/remove")
async def bulk_remove(request: BulkRemoveRequest):
    """Remove specified tags from multiple images."""
    return _do_bulk_remove(request)


@router.post("/cleanup")
async def cleanup(request: CleanupRequest):
    """Remove tags below confidence threshold and optionally dedupe."""
    return _do_cleanup(request)


@router.get("/state")
async def get_state():
    """Get current bulk operation state (for progress display)."""
    with _op_lock:
        return dict(_op_state)


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

    # Batch-load all tags up front to avoid N round-trips to SQLite.
    tags_by_image = db.get_image_tags_map(request.image_ids)

    affected_images = 0
    affected_tags = 0
    sample_changes: List[Dict[str, Any]] = []

    _begin_op("find_replace", len(request.image_ids))
    try:
        for image_id in request.image_ids:
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
                        db.add_tags(image_id, deduped)
            except Exception as exc:  # pragma: no cover — defensive
                logger.warning("find_replace failed for image %s: %s", image_id, exc)
                _record_op_error(image_id, str(exc))
            finally:
                _bump_op_progress()
    finally:
        _end_op()

    return {
        "operation": "find_replace",
        "dry_run": request.dry_run,
        "total_images_checked": len(request.image_ids),
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

    tags_by_image = db.get_image_tags_map(request.image_ids)

    affected_images = 0
    total_tags_added = 0
    sample_changes: List[Dict[str, Any]] = []

    _begin_op("bulk_add", len(request.image_ids))
    try:
        for image_id in request.image_ids:
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
                    db.add_tags(image_id, merged)
            except Exception as exc:  # pragma: no cover — defensive
                logger.warning("bulk_add failed for image %s: %s", image_id, exc)
                _record_op_error(image_id, str(exc))
            finally:
                _bump_op_progress()
    finally:
        _end_op()

    return {
        "operation": "bulk_add",
        "dry_run": request.dry_run,
        "total_images_checked": len(request.image_ids),
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

    tags_by_image = db.get_image_tags_map(request.image_ids)

    affected_images = 0
    total_tags_removed = 0
    sample_changes: List[Dict[str, Any]] = []

    _begin_op("bulk_remove", len(request.image_ids))
    try:
        for image_id in request.image_ids:
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
                        db.add_tags(image_id, kept)
            except Exception as exc:  # pragma: no cover — defensive
                logger.warning("bulk_remove failed for image %s: %s", image_id, exc)
                _record_op_error(image_id, str(exc))
            finally:
                _bump_op_progress()
    finally:
        _end_op()

    return {
        "operation": "bulk_remove",
        "dry_run": request.dry_run,
        "total_images_checked": len(request.image_ids),
        "affected_images": affected_images,
        "total_tags_removed": total_tags_removed,
        "sample_changes": sample_changes,
        "tags_to_remove": list(remove_set),
    }


def _do_cleanup(request: CleanupRequest) -> Dict[str, Any]:
    threshold = float(max(0.0, min(1.0, request.min_confidence)))

    tags_by_image = db.get_image_tags_map(request.image_ids)

    affected_images = 0
    total_low_conf = 0
    total_dupes = 0
    sample_changes: List[Dict[str, Any]] = []

    _begin_op("cleanup", len(request.image_ids))
    try:
        for image_id in request.image_ids:
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
                    db.add_tags(image_id, normalized)
            except Exception as exc:  # pragma: no cover — defensive
                logger.warning("cleanup failed for image %s: %s", image_id, exc)
                _record_op_error(image_id, str(exc))
            finally:
                _bump_op_progress()
    finally:
        _end_op()

    return {
        "operation": "cleanup",
        "dry_run": request.dry_run,
        "total_images_checked": len(request.image_ids),
        "affected_images": affected_images,
        "total_low_conf_removed": total_low_conf,
        "total_duplicates_removed": total_dupes,
        "sample_changes": sample_changes,
        "min_confidence": threshold,
        "dedupe": request.dedupe,
    }
