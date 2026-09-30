"""Style vector extraction jobs for the style map (slice S1).

One background job at a time walks the current library's images that have
no vector for a space (or a vector from other weights / other pixels), asks
the loaded artist model for its feature vector and stores it in
``image_style_vectors``. Progress is polled; the job can be paused, resumed
and cancelled between images.

Spaces:
- ``kaloscope``: the 2048-d head-BN feature of the Kaloscope 2.0 classifier
  (``ArtistIdentifier.extract_style_vector``). The model must already be
  prepared in the Model Center; nothing is downloaded here.
- CLIP vectors are the similarity index in ``images.embedding`` and are not
  duplicated into this table.

The model version stamped on every row comes from the pure
``kaloscope_style_vector_model_version``; nothing here constructs an artist
identifier just to look something up, because ``get_artist_identifier``
rebuilds (and drops) the loaded 2.8 GB singleton whenever the requested
settings differ from the current one. The worker is the only caller, and it
runs only after the job has been started and not cancelled.
"""

from __future__ import annotations

import gc
import logging
import os
import threading
import time
from typing import Any, Callable, Dict, List, Optional

import database as db
from ai_runtime_guard import PRIORITY_BATCH
from artist_identifier import (
    ARTIST_NOT_PREPARED_ERROR,
    ARTIST_THRESHOLD_DEFAULT,
    get_artist_identifier,
    kaloscope_style_vector_model_version,
)
from db_style_vectors import (
    pending_style_vector_rows,
    style_vector_counts,
    upsert_style_vector,
)
from exceptions import OperationInProgressError, ServiceError, ValidationError
from image_fingerprint import compute_image_content_fingerprint
from library_context import current_library_sql
from services.derived_state_service import initialize_image_content_fingerprint
from utils.source_paths import resolve_existing_indexed_image_path

logger = logging.getLogger(__name__)

STYLE_VECTOR_SPACES = ("kaloscope",)
STYLE_VECTOR_UNSUPPORTED_ERROR = (
    "Style vectors need the Kaloscope 2.0 artist model; the loaded artist model "
    "cannot provide a feature vector. / 画风向量需要 Kaloscope 2.0 画风识别模型，"
    "当前加载的模型无法输出特征向量。"
)
STYLE_VECTOR_FINGERPRINT_ERROR = "Could not fingerprint the image pixels."
STYLE_VECTOR_STALE_ERROR = (
    "The image changed since it was scanned; rescan the folder and try again."
)
_PAUSE_POLL_SECONDS = 0.1
_GC_EVERY = 8
_RECENT_ISSUES = 10

PendingRow = tuple[int, str, Optional[str], Optional[str]]


def _weights_path_load_would_use(model_path: Optional[str]) -> Optional[str]:
    """The local file ``ArtistIdentifier.load()`` will open, or None for the official weights.

    ``load()`` opens ``model_path`` whenever it exists, whatever ``model_source``
    says, and otherwise fetches the official checkpoint; the version stamped on
    the vectors must follow the same rule or it names weights that never ran.
    """
    if not model_path:
        return None
    candidate = os.path.expanduser(str(model_path).strip())
    return candidate if candidate and os.path.isfile(candidate) else None


def _model_version_for(model_path: Optional[str]) -> str:
    """Pure version lookup; an unreadable local file is a request error."""
    try:
        return kaloscope_style_vector_model_version(
            _weights_path_load_would_use(model_path)
        )
    except ValueError as exc:
        raise ValidationError(str(exc), field="model_path") from exc


class StyleVectorService:
    """Owns the one style-vector extraction job and its progress state."""

    def __init__(self, identifier_getter: Optional[Callable[..., Any]] = None) -> None:
        self._identifier_getter = identifier_getter or get_artist_identifier
        self._lock = threading.Lock()
        self._cancel_requested = False
        self._pause_requested = False
        self._progress: Dict[str, Any] = self._new_progress()

    # ------------------------------------------------------------------ state
    @staticmethod
    def _new_progress() -> Dict[str, Any]:
        return {
            "running": False,
            "paused": False,
            "space": None,
            "total": 0,
            "processed": 0,
            "written": 0,
            "kept": 0,
            "errors": 0,
            "step": "idle",
            "message": "",
            "current_item": None,
            "started_at": None,
            "updated_at": None,
            "recent_issues": [],
        }

    def _update(self, **fields: Any) -> None:
        with self._lock:
            self._progress.update(fields)
            self._progress["updated_at"] = time.time()

    def _note_issue(self, text: str) -> None:
        with self._lock:
            issues = list(self._progress["recent_issues"])
            issues.append(text)
            self._progress["recent_issues"] = issues[-_RECENT_ISSUES:]

    def get_progress(self) -> Dict[str, Any]:
        with self._lock:
            snapshot = dict(self._progress)
            snapshot["recent_issues"] = list(self._progress["recent_issues"])
        return snapshot

    def is_running(self) -> bool:
        with self._lock:
            return bool(self._progress["running"])

    def _is_cancelled(self) -> bool:
        with self._lock:
            return self._cancel_requested

    def request_pause(self) -> bool:
        with self._lock:
            if not self._progress["running"]:
                return False
            self._pause_requested = True
            self._progress["paused"] = True
            self._progress["updated_at"] = time.time()
            return True

    def request_resume(self) -> bool:
        with self._lock:
            if not self._progress["running"]:
                return False
            self._pause_requested = False
            self._progress["paused"] = False
            self._progress["updated_at"] = time.time()
            return True

    def request_cancel(self) -> bool:
        with self._lock:
            if not self._progress["running"]:
                return False
            self._cancel_requested = True
            self._pause_requested = False
            self._progress["paused"] = False
            self._progress["updated_at"] = time.time()
            return True

    # -------------------------------------------------------------- queries
    @staticmethod
    def _require_space(space: str) -> str:
        normalized = str(space or "").strip().lower()
        if normalized not in STYLE_VECTOR_SPACES:
            raise ValidationError(
                f"Unknown style space {space!r}; expected one of {', '.join(STYLE_VECTOR_SPACES)}",
                field="space",
            )
        return normalized

    @staticmethod
    def _ids_from_selection_token(selection_token: str) -> List[int]:
        """Every picture of the filter the token stands for (id order is
        irrelevant here: the pending query sorts by id)."""
        from fastapi import HTTPException

        from services.image.selection import selection_contract_db_filters
        from services.image_service import ImageService

        try:
            contract = ImageService()._decode_selection_token(selection_token)
        except HTTPException as exc:  # the decoder speaks HTTP; this layer does not
            raise ValidationError(
                str(exc.detail or "Invalid selection token"), field="selection_token"
            ) from exc
        ids: List[int] = []
        for chunk in db.iter_filtered_image_id_chunks(
            chunk_size=5000,
            sort_by="newest",
            **selection_contract_db_filters(contract),
        ):
            ids.extend(int(value) for value in chunk)
        return ids

    def _pending_rows(
        self,
        *,
        space: str,
        model_version: str,
        image_ids: Optional[List[int]],
    ) -> list[PendingRow]:
        library_sql, library_params = current_library_sql("i.library_id")
        with db.get_db() as conn:
            return pending_style_vector_rows(
                conn.cursor(),
                space=space,
                model_version=model_version,
                library_sql=library_sql,
                library_params=library_params,
                image_ids=image_ids,
            )

    def get_stats(self, space: str, model_path: Optional[str] = None) -> Dict[str, Any]:
        """Coverage of ``space`` over the current library (no model is built or loaded)."""
        normalized = self._require_space(space)
        model_version = _model_version_for(model_path)
        library_sql, library_params = current_library_sql("i.library_id")
        with db.get_db() as conn:
            counts = style_vector_counts(
                conn.cursor(),
                space=normalized,
                model_version=model_version,
                library_sql=library_sql,
                library_params=library_params,
            )
        counts.update({"space": normalized, "model_version": model_version})
        return counts

    # ----------------------------------------------------------------- start
    def start_extraction(
        self,
        background_tasks,
        *,
        space: str,
        image_ids: Optional[List[int]] = None,
        use_gpu: Optional[bool] = None,
        model_source: str = "huggingface",
        model_path: Optional[str] = None,
        selection_token: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Queue the job for every pending image (or the given ids, or the
        pictures of a Gallery filter token) and return its size."""
        normalized = self._require_space(space)
        model_version = _model_version_for(model_path)
        if selection_token:
            if image_ids is not None:
                raise ValidationError(
                    "Give either image_ids or selection_token, not both",
                    field="selection_token",
                )
            # Decoded and expanded server side (the same contract every
            # filtered action reads) before the slot is claimed, so a bad
            # token never leaves a job marked running.
            image_ids = self._ids_from_selection_token(selection_token)
        with self._lock:
            if self._progress["running"]:
                raise OperationInProgressError("Style vector extraction")
            # Claim the slot before the (possibly slow) pending query so two
            # starts cannot both pass the check.
            self._cancel_requested = False
            self._pause_requested = False
            self._progress = self._new_progress()
            self._progress.update(
                {
                    "running": True,
                    "space": normalized,
                    "step": "queued",
                    "message": "Finding images without a style vector...",
                    "started_at": time.time(),
                    "updated_at": time.time(),
                }
            )
        try:
            rows = self._pending_rows(
                space=normalized, model_version=model_version, image_ids=image_ids
            )
        except Exception:
            self._update(
                running=False, step="error", message="Could not list pending images."
            )
            raise
        if not rows:
            self._update(
                running=False,
                step="idle",
                message="Every image already has a style vector.",
                total=0,
            )
            return {"status": "idle", "total": 0, "space": normalized}

        self._update(total=len(rows), message=f"Queued {len(rows)} image(s).")
        background_tasks.add_task(
            self._run_extraction,
            normalized,
            rows,
            model_version,
            use_gpu,
            model_source,
            model_path,
        )
        return {"status": "started", "total": len(rows), "space": normalized}

    # ---------------------------------------------------------------- worker
    def _wait_while_paused(self) -> None:
        while True:
            with self._lock:
                if self._cancel_requested or not self._pause_requested:
                    return
            time.sleep(_PAUSE_POLL_SECONDS)

    def _load_identifier(self, *, use_gpu, model_source, model_path):
        """Build, load and capability-check the artist model exactly once.

        Runs before the first image: a runtime that fails to load, a model
        that is not Kaloscope, or a stub without a feature layer ends the
        job here with a clear message instead of failing every image.
        """
        identifier = self._identifier_getter(
            model_path=model_path,
            model_source=model_source,
            threshold=ARTIST_THRESHOLD_DEFAULT,
            use_gpu=use_gpu,
        )
        load = getattr(identifier, "load", None)
        if callable(load):
            load()
        if getattr(identifier, "model_loaded", True) is False:
            raise ServiceError(
                str(
                    getattr(identifier, "load_error", None) or ARTIST_NOT_PREPARED_ERROR
                )
            )
        supports = getattr(identifier, "supports_style_vectors", None)
        if not callable(supports) or not supports():
            raise ServiceError(STYLE_VECTOR_UNSUPPORTED_ERROR)
        if not callable(getattr(identifier, "extract_style_vector", None)):
            raise ServiceError(STYLE_VECTOR_UNSUPPORTED_ERROR)
        return identifier

    def _extract_one(
        self,
        identifier,
        *,
        space: str,
        model_version: str,
        image_id: int,
        indexed_path: str,
        stored_fingerprint: Optional[str] = None,
        stored_version: Optional[str] = None,
    ) -> str:
        """Return ``"kept"`` when the stored vector still fits, ``"written"`` otherwise."""
        image_path = resolve_existing_indexed_image_path(
            indexed_path, backend_file=__file__
        )
        if not image_path:
            try:
                db.mark_image_unreadable(image_id, "File not found")
            except Exception:
                logger.debug(
                    "Failed to mark image %s unreadable during style extraction",
                    image_id,
                )
            raise FileNotFoundError(f"Image file not found for image {image_id}")

        fingerprint = str(compute_image_content_fingerprint(image_path) or "").strip()
        if not fingerprint:
            raise ServiceError(STYLE_VECTOR_FINGERPRINT_ERROR)
        with db.get_db() as conn:
            current = initialize_image_content_fingerprint(
                conn.cursor(), image_id=image_id, content_fingerprint=fingerprint
            )
        if not current:
            raise ServiceError(STYLE_VECTOR_STALE_ERROR)
        if stored_fingerprint == fingerprint and stored_version == model_version:
            # The scan had forgotten the fingerprint but the pixels are the
            # same: the stored vector is still right, no need to run the model.
            return "kept"

        vector = identifier.extract_style_vector(image_path, priority=PRIORITY_BATCH)

        with db.get_db() as conn:
            written = upsert_style_vector(
                conn.cursor(),
                image_id=image_id,
                space=space,
                model_version=model_version,
                content_fingerprint=fingerprint,
                vector=vector,
            )
        if not written:
            raise ServiceError(STYLE_VECTOR_STALE_ERROR)
        return "written"

    def _finish_cancelled(
        self, processed: int, total: int, written: int, kept: int
    ) -> None:
        self._update(
            running=False,
            paused=False,
            step="cancelled",
            current_item=None,
            message=f"Cancelled after {processed}/{total} image(s); {written} stored, {kept} kept.",
        )
        logger.info("Style vector extraction cancelled at %d/%d", processed, total)

    def _run_extraction(
        self,
        space: str,
        rows: list[PendingRow],
        model_version: str,
        use_gpu: Optional[bool],
        model_source: str,
        model_path: Optional[str],
    ) -> None:
        try:
            if self._is_cancelled():
                # Cancelled between start and the worker's first breath: do
                # not build or load a model for nothing.
                self._finish_cancelled(0, len(rows), 0, 0)
                return
            self._update(step="loading_runtime", message="Loading the artist model...")
            identifier = self._load_identifier(
                use_gpu=use_gpu, model_source=model_source, model_path=model_path
            )
            self._update(
                step="extracting", message=f"Extracting {len(rows)} style vector(s)..."
            )

            processed = written = kept = errors = 0
            cancelled = False
            for image_id, indexed_path, stored_fingerprint, stored_version in rows:
                self._wait_while_paused()
                if self._is_cancelled():
                    cancelled = True
                    break
                current_item = os.path.basename(indexed_path or "") or str(image_id)
                self._update(
                    current_item=current_item, message=f"Extracting {current_item}"
                )
                try:
                    outcome = self._extract_one(
                        identifier,
                        space=space,
                        model_version=model_version,
                        image_id=image_id,
                        indexed_path=indexed_path,
                        stored_fingerprint=stored_fingerprint,
                        stored_version=stored_version,
                    )
                    if outcome == "kept":
                        kept += 1
                    else:
                        written += 1
                except Exception as exc:  # one bad image must not stop the batch
                    errors += 1
                    logger.warning(
                        "Style vector failed for image %s: %s", image_id, exc
                    )
                    self._note_issue(f"{current_item}: {exc}")
                finally:
                    processed += 1
                    self._update(
                        processed=processed, written=written, kept=kept, errors=errors
                    )
                    if processed % _GC_EVERY == 0:
                        gc.collect()
                        try:
                            import torch

                            if torch.cuda.is_available():
                                torch.cuda.empty_cache()
                        except Exception:
                            pass

            if cancelled:
                self._finish_cancelled(processed, len(rows), written, kept)
                return
            if processed > 0 and written == 0 and kept == 0:
                # Every image failed: that is a broken run, not a finished one.
                self._update(
                    running=False,
                    paused=False,
                    step="error",
                    current_item=None,
                    message=f"No style vector could be stored: all {errors} image(s) failed. See recent issues.",
                )
                return
            self._update(
                running=False,
                paused=False,
                step="done",
                current_item=None,
                message=f"Stored {written} style vector(s), kept {kept}; {errors} failed.",
            )
        except Exception as exc:
            logger.error("Style vector extraction failed: %s", exc)
            self._update(
                running=False,
                paused=False,
                step="error",
                current_item=None,
                message=f"Style vector extraction failed: {exc}",
            )
