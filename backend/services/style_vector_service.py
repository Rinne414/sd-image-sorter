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
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Optional, Sequence

import numpy as np

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
from library_context import current_library_sql
from services.derived_state_service import write_artist_predictions
from services.style_vector_prepare import (  # noqa: F401 - re-exported names
    STYLE_VECTOR_FINGERPRINT_ERROR,
    STYLE_VECTOR_STALE_ERROR,
    PendingRow,
    PreparedPicture as _Prepared,
    prepare_picture,
)

logger = logging.getLogger(__name__)

STYLE_VECTOR_SPACES = ("kaloscope",)
# top_k the Style Finder page sends for a batch (frontend/js/artist/identify.js
# _getIdentifyPayload): fixed there, so fixed here. The threshold is the page's
# slider and travels with every start request instead.
ARTIST_INDEX_TOP_K = 5
STYLE_VECTOR_UNSUPPORTED_ERROR = (
    "Style vectors need the Kaloscope 2.0 artist model; the loaded artist model "
    "cannot provide a feature vector. / 画风向量需要 Kaloscope 2.0 画风识别模型，"
    "当前加载的模型无法输出特征向量。"
)
STYLE_VECTOR_BAD_VECTOR_ERROR = (
    "The model answered a non-finite or empty style vector for this image."
)
_PAUSE_POLL_SECONDS = 0.1
_RECENT_ISSUES = 10
# Throughput (S1b, measured on a 3090 with 200 pictures): one forward per
# picture ran at 3.9 pictures/s with the GPU busy 29% of the time; the
# forward alone reaches ~50 pictures/s at batch 4-8, and decoding + hashing
# the next batch on helper threads overlaps the GPU work. Pause and cancel
# are answered between batches, so one batch bounds their reaction time.
EXTRACTION_BATCH_SIZE = 8
# Helper threads that resolve, fingerprint, decode and transform the
# pictures of the NEXT batch (one picture per task, so this many run at
# once) while the GPU works on the current one; bounded: this many threads
# plus the worker itself.
_PREPARE_THREADS = 2
# gc.collect() cost ~100 ms a call; once per this many pictures is plenty.
_GC_EVERY_IMAGES = 64
# Memory: at most two batches are alive, the one on the GPU and the one
# prepared ahead (2 x EXTRACTION_BATCH_SIZE = 16 pictures). With Kaloscope
# each prepared picture is its 3x448x448 float32 input (~2.4 MB) and the
# decoded image is dropped right after the transform; an identifier without
# prepare_style_input keeps the decoded RGB image instead (a 4K picture is
# ~25 MB, so 16 of them ~400 MB).


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


def style_vector_model_version(model_path: Optional[str]) -> str:
    """The vector version the user's model settings name (the map reads it too)."""
    return _model_version_for(model_path)


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
        with_artist: bool = True,
        threshold: float = ARTIST_THRESHOLD_DEFAULT,
    ) -> Dict[str, Any]:
        """Queue the job for every pending image (or the given ids, or the
        pictures of a Gallery filter token) and return its size.

        ``with_artist`` (default on): the same forward also identifies the
        artist and stores it exactly as the Style Finder page does, tiered
        with ``threshold`` (the page's slider, so the row the index writes
        is the row an identify-batch at the same setting would write).
        """
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
            with_artist,
            float(threshold),
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
        # The singleton is built with the default floor exactly as
        # ArtistService._identifier builds it (the request threshold is
        # passed per call, never baked into the shared model).
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

    # ------------------------------------------------------- GPU stage
    def _identify_batch(
        self,
        identifier,
        batch: List[_Prepared],
        with_artist: bool,
        threshold: float = ARTIST_THRESHOLD_DEFAULT,
    ):
        """(vector, raw identification | None) per prepared picture, or an
        exception in that slot. One forward for the whole batch when the
        identifier offers it; a batch that fails as a whole is retried one
        picture at a time so a single bad picture costs one error only."""
        combined_batch = getattr(
            identifier, "extract_style_vectors_and_identifications", None
        )
        if with_artist and callable(combined_batch) and len(batch) > 1:
            try:
                outputs = combined_batch(
                    [(item.image_path, item.payload) for item in batch],
                    top_k=ARTIST_INDEX_TOP_K,
                    threshold=threshold,
                    priority=PRIORITY_BATCH,
                )
                if len(outputs) == len(batch):
                    return [(vector, raw) for vector, raw in outputs]
                logger.warning(
                    "Batched style extraction answered %d of %d pictures; retrying one by one",
                    len(outputs),
                    len(batch),
                )
            except Exception as exc:
                logger.warning(
                    "Batched style extraction failed (%s); retrying one by one", exc
                )
        results = []
        for item in batch:
            try:
                results.append(
                    self._identify_one(identifier, item, with_artist, threshold)
                )
            except Exception as exc:
                results.append(exc)
        return results

    @staticmethod
    def _identify_one(
        identifier,
        item: _Prepared,
        with_artist: bool,
        threshold: float = ARTIST_THRESHOLD_DEFAULT,
    ):
        """One picture: the batch interface with a batch of one, fed the
        already prepared input (no second decode, no re-read of a file that
        may have changed meanwhile); older identifiers take a path."""
        combined_batch = getattr(
            identifier, "extract_style_vectors_and_identifications", None
        )
        if with_artist and callable(combined_batch) and item.payload is not None:
            outputs = combined_batch(
                [(item.image_path, item.payload)],
                top_k=ARTIST_INDEX_TOP_K,
                threshold=threshold,
                priority=PRIORITY_BATCH,
            )
            if len(outputs) != 1:
                raise ServiceError(STYLE_VECTOR_UNSUPPORTED_ERROR)
            vector, raw = outputs[0]
            return vector, raw
        combined = getattr(identifier, "extract_style_vector_and_identification", None)
        if with_artist and callable(combined):
            return combined(
                item.image_path,
                top_k=ARTIST_INDEX_TOP_K,
                threshold=threshold,
                priority=PRIORITY_BATCH,
            )
        return identifier.extract_style_vector(
            item.image_path, priority=PRIORITY_BATCH
        ), None

    @staticmethod
    def _check_vector(vector) -> None:
        """What the store would refuse, caught before the transaction."""
        array = np.asarray(vector, dtype=np.float32).reshape(-1)
        if array.size == 0 or not np.all(np.isfinite(array)):
            raise ServiceError(STYLE_VECTOR_BAD_VECTOR_ERROR)
        if float(np.linalg.norm(array)) <= 0.0:
            raise ServiceError(STYLE_VECTOR_BAD_VECTOR_ERROR)

    @staticmethod
    def _prediction_for(item: _Prepared, raw) -> Optional[Dict[str, Any]]:
        """The Style Finder's own row for this picture (its normaliser, its writer)."""
        if not raw or raw.get("error"):
            return None
        from services.artist_service import normalize_identification

        normalized = normalize_identification(raw)
        return {
            "image_id": item.image_id,
            "artist": normalized["artist"],
            "confidence": normalized["confidence"],
            "top_predictions": normalized["top_predictions"],
            "content_fingerprint": item.fingerprint,
        }

    def _extract_batch(
        self,
        identifier,
        batch: List[_Prepared],
        *,
        space: str,
        model_version: str,
        with_artist: bool,
        threshold: float = ARTIST_THRESHOLD_DEFAULT,
    ) -> List[Any]:
        """Per picture: ``"kept"``, ``"written"`` or the exception to report.

        Vectors and predictions of a batch land in one transaction, each
        picture inside its own SAVEPOINT: a vector the store refuses, a
        fingerprint the scan replaced meanwhile (``STYLE_VECTOR_STALE_ERROR``)
        or a failing prediction write costs that picture only, and its
        partial rows are rolled back while the others stay.
        """
        outcomes: List[Any] = [
            item.error or ("kept" if item.kept else None) for item in batch
        ]
        todo = [index for index, outcome in enumerate(outcomes) if outcome is None]
        if not todo:
            return outcomes
        answers = self._identify_batch(
            identifier, [batch[index] for index in todo], with_artist, threshold
        )
        for item in batch:
            item.close()
        with db.get_db() as conn:
            cursor = conn.cursor()
            for index, answer in zip(todo, answers):
                item = batch[index]
                if isinstance(answer, Exception):
                    outcomes[index] = answer
                    continue
                vector, raw = answer
                try:
                    self._check_vector(vector)
                    cursor.execute("SAVEPOINT style_item")
                    try:
                        outcomes[index] = self._write_one(
                            cursor,
                            item,
                            vector,
                            raw,
                            space=space,
                            model_version=model_version,
                            with_artist=with_artist,
                        )
                        cursor.execute("RELEASE SAVEPOINT style_item")
                    except Exception:
                        cursor.execute("ROLLBACK TO SAVEPOINT style_item")
                        cursor.execute("RELEASE SAVEPOINT style_item")
                        raise
                except Exception as exc:  # this picture only
                    outcomes[index] = exc
        return outcomes

    def _write_one(
        self, cursor, item: _Prepared, vector, raw, *, space, model_version, with_artist
    ):
        written = upsert_style_vector(
            cursor,
            image_id=item.image_id,
            space=space,
            model_version=model_version,
            content_fingerprint=item.fingerprint,
            vector=vector,
        )
        if not written:
            raise ServiceError(STYLE_VECTOR_STALE_ERROR)
        prediction = self._prediction_for(item, raw) if with_artist else None
        if prediction is not None:
            write_artist_predictions(cursor, [prediction])
        return "written"

    def _run_batches(
        self,
        identifier,
        rows: Sequence[PendingRow],
        *,
        space: str,
        model_version: str,
        with_artist: bool,
        threshold: float = ARTIST_THRESHOLD_DEFAULT,
    ) -> tuple[int, int, int, int, bool]:
        """Walk the rows batch by batch; returns (processed, written, kept, errors, cancelled).

        The next batch's CPU work (resolve, fingerprint, decode) runs on
        helper threads while the model works on the current one. Pause and
        cancel are checked before each batch: a cancel drops the batch that
        was prepared ahead without counting it.
        """
        size = max(1, int(EXTRACTION_BATCH_SIZE))
        batches = [rows[start : start + size] for start in range(0, len(rows), size)]
        processed = written = kept = errors = 0
        cancelled = False
        executor = ThreadPoolExecutor(
            max_workers=_PREPARE_THREADS, thread_name_prefix="style-index-prepare"
        )
        # One task per picture, so _PREPARE_THREADS pictures are prepared at once.
        submit = lambda rows: [  # noqa: E731
            executor.submit(prepare_picture, row, model_version, identifier)
            for row in rows
        ]
        ahead: List[Future] = []
        try:
            if batches:
                ahead = submit(batches[0])
            for index, batch_rows in enumerate(batches):
                self._wait_while_paused()
                if self._is_cancelled():
                    cancelled = True
                    break
                prepared = [future.result() for future in ahead]
                ahead = submit(batches[index + 1]) if index + 1 < len(batches) else []
                first = prepared[0].name
                label = (
                    first if len(prepared) == 1 else f"{first} (+{len(prepared) - 1})"
                )
                self._update(current_item=first, message=f"Extracting {label}")
                outcomes = self._extract_batch(
                    identifier,
                    prepared,
                    space=space,
                    model_version=model_version,
                    with_artist=with_artist,
                    threshold=threshold,
                )
                for item, outcome in zip(prepared, outcomes):
                    if outcome == "kept":
                        kept += 1
                    elif outcome == "written":
                        written += 1
                    else:  # one bad image must not stop the batch
                        errors += 1
                        logger.warning(
                            "Style vector failed for image %s: %s",
                            item.image_id,
                            outcome,
                        )
                        self._note_issue(f"{item.name}: {outcome}")
                    processed += 1
                self._update(
                    processed=processed, written=written, kept=kept, errors=errors
                )
                if (
                    processed // _GC_EVERY_IMAGES
                    != (processed - len(prepared)) // _GC_EVERY_IMAGES
                ):
                    self._release_memory()
        finally:
            executor.shutdown(wait=True, cancel_futures=True)
            for future in ahead:  # a batch prepared ahead of a cancel: dropped
                if future.done() and not future.cancelled():
                    try:
                        future.result().close()
                    except Exception:
                        pass
        return processed, written, kept, errors, cancelled

    @staticmethod
    def _release_memory() -> None:
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

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
        with_artist: bool = True,
        threshold: float = ARTIST_THRESHOLD_DEFAULT,
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
            processed, written, kept, errors, cancelled = self._run_batches(
                identifier,
                rows,
                space=space,
                model_version=model_version,
                with_artist=with_artist,
                threshold=threshold,
            )

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
