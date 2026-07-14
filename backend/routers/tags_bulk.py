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
import re
import threading
from contextlib import contextmanager
from typing import Any, Callable, Dict, Iterator, List, Literal, NoReturn, Optional, TypedDict

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator

import database as db
from db_tags import _dedupe_tag_rows
from services import tag_bulk_journal
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

BulkWarningCode = Literal[
    "undo_journal_truncated",
    "undo_journal_persistence_failed",
]


class BulkOperationWarning(TypedDict):
    code: BulkWarningCode
    message: str


class JournalApiResult(TypedDict):
    op_id: Optional[str]
    undo_available: bool
    warnings: List[BulkOperationWarning]


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


def _record_scope_estimate_failure(operation: str, detail: str) -> None:
    """Replace stale progress with the latest pre-mutation scope failure."""
    with _op_lock:
        _op_state.update({
            "running": False,
            "operation": operation,
            "total": 0,
            "completed": 0,
            "errors": [{"image_id": 0, "error": detail}],
        })


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
    minUserRating: Optional[int] = Field(default=None, ge=0, le=5)
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
    excludePrompts: List[str] = Field(default_factory=list)
    excludeColors: List[str] = Field(default_factory=list)
    colorHues: List[str] = Field(default_factory=list)  # v3.5.0
    excludeColorHues: List[str] = Field(default_factory=list)  # v3.5.0
    collectionId: Optional[int] = Field(default=None, ge=1)
    folder: Optional[str] = Field(default=None, max_length=4096)
    hasMetadata: Optional[bool] = None

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

    @field_validator("image_ids")
    @classmethod
    def dedupe_explicit_image_ids(cls, image_ids: Optional[List[int]]) -> Optional[List[int]]:
        if image_ids is None:
            return None
        return list(dict.fromkeys(image_ids))

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
    # QW-3: opt-in regex mode. ``find`` becomes a whole-tag fullmatch
    # pattern; ``replace`` may use backrefs (\\1). Literal whole-tag
    # equality stays the safe default.
    regex: bool = False
    dry_run: bool = False


class BulkAddRequest(BulkTagScopeRequest):
    tags: List[str] = Field(min_length=1, max_length=200)
    confidence: float = 0.85
    dry_run: bool = False

    @field_validator("tags")
    @classmethod
    def normalize_tags(cls, tags: List[str]) -> List[str]:
        normalized: List[str] = []
        seen: set[str] = set()
        for raw_tag in tags:
            tag = raw_tag.strip()
            tag_key = tag.lower()
            if not tag or tag_key in seen:
                continue
            seen.add(tag_key)
            normalized.append(tag)
        if not normalized:
            raise ValueError("tags list cannot be empty")
        return normalized


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


class BulkUndoRequest(BaseModel):
    force: bool = False


@router.get("/ops")
async def list_bulk_ops(limit: int = 20):
    """List recent applied bulk ops with undo availability (FE-2s journal)."""
    from services import tag_bulk_journal

    return {"ops": tag_bulk_journal.list_ops(limit=max(1, min(int(limit), 100)))}


@router.post("/undo/{op_id}")
def undo_bulk_op(op_id: str, request: BulkUndoRequest):
    """Undo one journaled bulk op. Conflicted images are skipped unless force."""
    from services import tag_bulk_journal

    def _do_undo(req: BulkUndoRequest):
        try:
            return tag_bulk_journal.undo_op(op_id, force=req.force)
        except KeyError:
            raise HTTPException(404, "Unknown bulk operation id")
        except ValueError as exc:
            raise HTTPException(409, str(exc))

    return _run_exclusive("bulk_undo", _do_undo, request)


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
        "min_user_rating": filters.minUserRating,
        "brightness_min": filters.brightnessMin,
        "brightness_max": filters.brightnessMax,
        "color_temperature": filters.colorTemperature,
        "brightness_distribution": filters.brightnessDistribution,
        "exclude_tags": _list_or_none(filters.excludeTags),
        "exclude_generators": _list_or_none(filters.excludeGenerators),
        "exclude_ratings": _list_or_none(filters.excludeRatings),
        "exclude_checkpoints": _list_or_none(filters.excludeCheckpoints),
        "exclude_loras": _list_or_none(filters.excludeLoras),
        "exclude_prompts": _list_or_none(filters.excludePrompts),
        "exclude_colors": _list_or_none(filters.excludeColors),
        "color_hues": _list_or_none(filters.colorHues),
        "exclude_color_hues": _list_or_none(filters.excludeColorHues),
        "collection_id": filters.collectionId,
        "folder": filters.folder,
        "has_metadata": filters.hasMetadata,
    }


def _iter_filter_contract_id_chunks(filters: BulkTagFilterContract) -> Iterator[List[int]]:
    # Snapshot the matching IDs BEFORE any chunk is committed. The canonical
    # bulk flow (filter gallery by tag X -> mass-remove/replace tag X) mutates
    # the very rows the filter matches; live offset pagination would skip
    # roughly half of them as the matching set shrinks between chunks.
    yield from db.iter_id_snapshot_chunks(
        db.iter_filtered_image_id_chunks(
            chunk_size=BULK_TAG_ID_CHUNK_SIZE,
            sort_by=filters.sortBy,
            **_filter_contract_db_kwargs(filters),
        ),
        chunk_size=BULK_TAG_ID_CHUNK_SIZE,
    )


def _iter_scope_id_chunks(request: BulkTagScopeRequest) -> Iterator[List[int]]:
    if request.image_ids is not None:
        yield from _iter_explicit_id_chunks(request.image_ids)
        return
    if request.selection_token:
        yield from iter_selection_token_id_chunks(
            request.selection_token,
            chunk_size=BULK_TAG_ID_CHUNK_SIZE,
            snapshot=True,
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


def _estimate_scope_total_or_raise(
    operation: str,
    request: BulkTagScopeRequest,
) -> int:
    """Expose scope read failures before any mutation begins."""
    try:
        return _estimate_scope_total(request)
    except HTTPException:
        raise
    except Exception as exc:
        detail = (
            f"Bulk tag {operation} scope estimate failed; no changes were applied. "
            f"Cause: {type(exc).__name__}: {exc}"
        )
        _record_scope_estimate_failure(operation, detail)
        logger.exception(
            "bulk tag scope estimate failed",
            extra={
                "operation": operation,
                "error_type": type(exc).__name__,
            },
        )
        raise HTTPException(status_code=500, detail=detail) from exc


def _scope_source(request: BulkTagScopeRequest) -> str:
    if request.image_ids is not None:
        return "image_ids"
    if request.selection_token:
        return "selection_token"
    return "filters"


def _confidence_from_row(row: Dict[str, Any]) -> float:
    """Return numeric confidence without treating a valid zero as missing."""
    raw_confidence: object = row.get("confidence")
    if raw_confidence is None:
        return 1.0
    if isinstance(raw_confidence, bool) or not isinstance(
        raw_confidence,
        (int, float, str),
    ):
        raise TypeError(
            "Tag confidence must be numeric; received "
            f"{type(raw_confidence).__name__}."
        )
    try:
        return float(raw_confidence)
    except ValueError as exc:
        raise ValueError(
            f"Tag confidence must be numeric; received {raw_confidence!r}."
        ) from exc


def _preserve_row(t: Dict[str, Any]) -> Dict[str, Any]:
    """Rebuild a tag row for re-commit, carrying provenance columns.

    Bulk ops rewrite the FULL tag list of an image via
    add_tags(replace_scope="all"); dropping source/category here would
    wipe migration-024 provenance and let the next pipeline re-tag
    delete formerly-manual rows.
    """
    return {
        "tag": str(t.get("tag") or ""),
        "confidence": _confidence_from_row(t),
        "source": t.get("source"),
        "category": t.get("category"),
    }


def _row_from_tuple(row) -> Dict[str, Any]:
    """(tag, confidence, source, category) from _dedupe_tag_rows -> row dict."""
    tag, confidence, source, category = row
    return {"tag": tag, "confidence": confidence, "source": source, "category": category}


def _create_journal_buffer() -> tag_bulk_journal.JournalBuffer:
    return tag_bulk_journal.create_journal_buffer(
        tag_bulk_journal.MAX_JOURNAL_IMAGES,
        tag_bulk_journal.MAX_JOURNAL_SERIALIZED_BYTES,
    )


def _append_journal_entry(
    journal: tag_bulk_journal.JournalBuffer,
    image_id: int,
    before_rows: List[Dict[str, Any]],
    after_rows: List[Dict[str, Any]],
) -> None:
    tag_bulk_journal.append_journal_entry(
        journal,
        image_id,
        before_rows,
        after_rows,
    )


def _record_journal_if_applied(
    request: BulkTagScopeRequest,
    operation: str,
    params: Dict[str, Any],
    journal: tag_bulk_journal.JournalBuffer,
    images_affected: int,
) -> JournalApiResult:
    """Journal a committed operation and expose lost undo as a warning."""
    if request.dry_run or images_affected <= 0:
        return {"op_id": None, "undo_available": False, "warnings": []}
    try:
        record_result = tag_bulk_journal.record_op(
            operation=operation,
            scope_source=_scope_source(request),
            params=params,
            journal=journal,
            images_affected=images_affected,
        )
        if record_result.truncated:
            if record_result.truncation_reason == "serialized_byte_limit":
                limit_description = (
                    f"the {journal.max_serialized_bytes}-byte serialized-data limit"
                )
            else:
                limit_description = f"the {journal.max_images}-image limit"
            warning: BulkOperationWarning = {
                "code": "undo_journal_truncated",
                "message": (
                    "Tags were applied, but undo is unavailable because the journal "
                    f"exceeded {limit_description}."
                ),
            }
            return {
                "op_id": record_result.op_id,
                "undo_available": False,
                "warnings": [warning],
            }
        return {
            "op_id": record_result.op_id,
            "undo_available": True,
            "warnings": [],
        }
    except Exception as exc:
        logger.warning(
            "bulk undo journal record failed",
            extra={
                "operation": operation,
                "images_affected": images_affected,
                "error_type": type(exc).__name__,
            },
            exc_info=exc,
        )
        warning = {
            "code": "undo_journal_persistence_failed",
            "message": (
                "Tags were applied, but undo is unavailable because the journal "
                f"could not be saved. Cause: {type(exc).__name__}: {exc}"
            ),
        }
        return {"op_id": None, "undo_available": False, "warnings": [warning]}


def _commit_tag_updates(
    write_updates: Callable[[List[Dict[str, Any]]], None],
    updates: List[Dict[str, Any]],
) -> None:
    if not updates:
        return
    image_ids = [int(item["image_id"]) for item in updates]
    first_image_id = image_ids[0]
    try:
        write_updates(updates)
    except Exception as exc:
        detail = (
            f"Bulk tag update failed for {len(image_ids)} image(s) beginning with "
            f"image_id={first_image_id}; all changes were rolled back. Cause: "
            f"{type(exc).__name__}: {exc}"
        )
        _record_op_error(first_image_id, detail)
        logger.exception(
            "bulk tag transaction write failed",
            extra={
                "image_count": len(image_ids),
                "first_image_id": first_image_id,
                "error_type": type(exc).__name__,
            },
        )
        raise HTTPException(status_code=500, detail=detail) from exc


def _raise_bulk_preparation_error(
    operation: str,
    image_id: int,
    dry_run: bool,
    exc: Exception,
) -> NoReturn:
    """Abort a logical bulk operation when one image cannot be prepared."""
    outcome = (
        "no changes were applied"
        if dry_run
        else "all changes were rolled back"
    )
    detail = (
        f"Bulk tag {operation} failed while preparing image_id={image_id}; "
        f"{outcome}. Cause: {type(exc).__name__}: {exc}"
    )
    _record_op_error(image_id, detail)
    logger.exception(
        "bulk tag operation preparation failed",
        extra={
            "operation": operation,
            "image_id": image_id,
            "dry_run": dry_run,
            "error_type": type(exc).__name__,
        },
    )
    raise HTTPException(status_code=500, detail=detail) from exc


@contextmanager
def _bulk_tag_transaction(
    operation: str,
    dry_run: bool,
) -> Iterator[Callable[[List[Dict[str, Any]]], None]]:
    """Expose transaction lifecycle failures as actionable API errors."""
    try:
        with db.tag_update_transaction(
            default_source=None,
            replace_scope="all",
        ) as write_updates:
            yield write_updates
    except HTTPException:
        raise
    except Exception as exc:
        outcome = (
            "no changes were applied"
            if dry_run
            else "all changes were rolled back"
        )
        detail = (
            f"Bulk tag {operation} transaction failed; {outcome}. "
            f"Cause: {type(exc).__name__}: {exc}"
        )
        _record_op_error(0, detail)
        logger.exception(
            "bulk tag transaction failed",
            extra={
                "operation": operation,
                "dry_run": dry_run,
                "error_type": type(exc).__name__,
            },
        )
        raise HTTPException(status_code=500, detail=detail) from exc


# ====================================================================
# Implementations
# ====================================================================

def _do_find_replace(request: FindReplaceRequest) -> Dict[str, Any]:
    find = request.find.strip()
    replace = request.replace.strip()
    if not find:
        raise HTTPException(400, "find string cannot be empty")

    if request.regex:
        try:
            flags = 0 if request.case_sensitive else re.IGNORECASE
            pattern = re.compile(find, flags)
        except re.error as exc:
            raise HTTPException(400, f"Invalid regex: {exc}")
        if replace:
            try:
                pattern.sub(replace, "")
            except (re.error, IndexError) as exc:
                raise HTTPException(400, f"Invalid regex replacement: {exc}")
        match_fn = lambda tag: pattern.fullmatch(tag) is not None
        replacement_fn = (lambda tag: pattern.sub(replace, tag)) if replace else None
    elif request.case_sensitive:
        match_fn = lambda tag: tag == find
        replacement_fn = (lambda tag: replace) if replace else None
    else:
        find_lower = find.lower()
        match_fn = lambda tag: tag.lower() == find_lower
        replacement_fn = (lambda tag: replace) if replace else None

    total_estimate = _estimate_scope_total_or_raise("find_replace", request)
    total_checked = 0
    affected_images = 0
    affected_tags = 0
    sample_changes: List[Dict[str, Any]] = []
    journal = _create_journal_buffer()

    _begin_op("find_replace", total_estimate)
    try:
        with _bulk_tag_transaction(
            "find_replace",
            request.dry_run,
        ) as write_updates:
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
                                new_value = replacement_fn(tag_str).strip() if replacement_fn else ""
                                if new_value:  # replace with new tag
                                    # A user-initiated rename produces a
                                    # user-owned row; the old category no
                                    # longer applies to the new name.
                                    new_tags.append({
                                        "tag": new_value,
                                        "confidence": _confidence_from_row(t),
                                        "source": "manual",
                                        "category": None,
                                    })
                                # else: drop the tag (replace="" means remove)
                            else:
                                new_tags.append(_preserve_row(t))

                        if modified:
                            affected_images += 1
                            if len(sample_changes) < 5:
                                sample_changes.append({
                                    "image_id": image_id,
                                    "before": [t.get("tag") for t in existing],
                                    "after": [t.get("tag") for t in new_tags],
                                })
                            if not request.dry_run:
                                # Dedupe by tag name (case-insensitive) using unified logic
                                deduped = [
                                    _row_from_tuple(row)
                                    for row in _dedupe_tag_rows(new_tags, None)
                                ]
                                _append_journal_entry(
                                    journal,
                                    image_id,
                                    existing,
                                    deduped,
                                )
                                updates.append({"image_id": image_id, "tags": deduped})
                    except Exception as exc:
                        _raise_bulk_preparation_error(
                            "find_replace",
                            image_id,
                            request.dry_run,
                            exc,
                        )
                    finally:
                        total_checked += 1
                        _bump_op_progress()
                if not request.dry_run:
                    _commit_tag_updates(write_updates, updates)
    finally:
        _end_op()

    journal_result = _record_journal_if_applied(
        request,
        "find_replace",
        {"find": find, "replace": replace, "regex": bool(request.regex)},
        journal,
        affected_images,
    )

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
        **journal_result,
    }


def _do_bulk_add(request: BulkAddRequest) -> Dict[str, Any]:
    add_tags = list(request.tags)

    confidence = float(max(0.0, min(1.0, request.confidence)))

    total_estimate = _estimate_scope_total_or_raise("bulk_add", request)
    total_checked = 0
    affected_images = 0
    total_tags_added = 0
    sample_changes: List[Dict[str, Any]] = []
    journal = _create_journal_buffer()

    _begin_op("bulk_add", total_estimate)
    try:
        with _bulk_tag_transaction(
            "bulk_add",
            request.dry_run,
        ) as write_updates:
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
                                _preserve_row(t) for t in existing if t.get("tag")
                            ] + [
                                {"tag": t, "confidence": confidence, "source": "manual", "category": None}
                                for t in new_to_add
                            ]
                            _append_journal_entry(
                                journal,
                                image_id,
                                existing,
                                merged,
                            )
                            updates.append({"image_id": image_id, "tags": merged})
                    except Exception as exc:
                        _raise_bulk_preparation_error(
                            "bulk_add",
                            image_id,
                            request.dry_run,
                            exc,
                        )
                    finally:
                        total_checked += 1
                        _bump_op_progress()
                if not request.dry_run:
                    _commit_tag_updates(write_updates, updates)
    finally:
        _end_op()

    journal_result = _record_journal_if_applied(
        request, "bulk_add", {"tags": add_tags}, journal, affected_images
    )

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
        **journal_result,
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

    total_estimate = _estimate_scope_total_or_raise("bulk_remove", request)
    total_checked = 0
    affected_images = 0
    total_tags_removed = 0
    sample_changes: List[Dict[str, Any]] = []
    journal = _create_journal_buffer()

    _begin_op("bulk_remove", total_estimate)
    try:
        with _bulk_tag_transaction(
            "bulk_remove",
            request.dry_run,
        ) as write_updates:
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
                                kept.append(_preserve_row(t))

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
                                _append_journal_entry(
                                    journal,
                                    image_id,
                                    existing,
                                    kept,
                                )
                                updates.append({"image_id": image_id, "tags": kept})
                    except Exception as exc:
                        _raise_bulk_preparation_error(
                            "bulk_remove",
                            image_id,
                            request.dry_run,
                            exc,
                        )
                    finally:
                        total_checked += 1
                        _bump_op_progress()
                if not request.dry_run:
                    _commit_tag_updates(write_updates, updates)
    finally:
        _end_op()

    journal_result = _record_journal_if_applied(
        request,
        "bulk_remove",
        {"tags": sorted(remove_set)},
        journal,
        affected_images,
    )

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
        **journal_result,
    }


def _do_cleanup(request: CleanupRequest) -> Dict[str, Any]:
    threshold = float(max(0.0, min(1.0, request.min_confidence)))

    total_estimate = _estimate_scope_total_or_raise("cleanup", request)
    total_checked = 0
    affected_images = 0
    total_low_conf = 0
    total_dupes = 0
    sample_changes: List[Dict[str, Any]] = []
    journal = _create_journal_buffer()

    _begin_op("cleanup", total_estimate)
    try:
        with _bulk_tag_transaction(
            "cleanup",
            request.dry_run,
        ) as write_updates:
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
                            if _confidence_from_row(t) >= threshold
                        ]
                        low_conf_count = len(existing) - len(filtered)

                        # Dedupe (case-insensitive, keep highest confidence) using unified logic
                        dupe_count = 0
                        if request.dedupe:
                            deduped_rows = _dedupe_tag_rows(filtered, None)
                            dupe_count = len(filtered) - len(deduped_rows)
                            cleaned = [_row_from_tuple(row) for row in deduped_rows]
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
                                _preserve_row(t) for t in cleaned if t.get("tag")
                            ]
                            _append_journal_entry(
                                journal,
                                image_id,
                                existing,
                                normalized,
                            )
                            updates.append({"image_id": image_id, "tags": normalized})
                    except Exception as exc:
                        _raise_bulk_preparation_error(
                            "cleanup",
                            image_id,
                            request.dry_run,
                            exc,
                        )
                    finally:
                        total_checked += 1
                        _bump_op_progress()
                if not request.dry_run:
                    _commit_tag_updates(write_updates, updates)
    finally:
        _end_op()

    journal_result = _record_journal_if_applied(
        request,
        "cleanup",
        {"min_confidence": threshold, "dedupe": request.dedupe},
        journal,
        affected_images,
    )

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
        **journal_result,
    }
