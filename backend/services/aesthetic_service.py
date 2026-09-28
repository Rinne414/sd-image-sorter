"""
Aesthetic scoring service for DB-backed aesthetic routes.
"""
from __future__ import annotations

import gc
import logging
import sqlite3
import threading
from typing import Any, Callable, Dict, Optional

import aesthetic
import anime_aesthetic
import database as db
from aesthetic import AESTHETIC_SCORE_VERSION, AestheticScores
from exceptions import ImageFileNotFoundError, ImageNotFoundError, ServiceError
from image_fingerprint import compute_image_content_fingerprint
from services.derived_state_service import (
    initialize_image_content_fingerprint,
    write_image_aesthetic_score,
)
from utils.source_paths import resolve_existing_indexed_image_path


logger = logging.getLogger(__name__)

# An image needs scoring when it has no LAION score or one from an older build.
NEEDS_SCORE_SQL = "(aesthetic_score IS NULL OR aesthetic_version IS NULL OR aesthetic_version < ?)"
# ...or when an installed optional model (Waifu head, anime grade) has not scored it.
MISSING_WAIFU_SQL = "aesthetic_waifu IS NULL"
MISSING_ANIME_SQL = "aesthetic_anime IS NULL"


def _missing_extra_sql() -> str:
    """Rows lacking a score from an installed optional model; empty when none is installed."""
    missing = []
    if aesthetic.is_waifu_scoring():
        missing.append(MISSING_WAIFU_SQL)
    if anime_aesthetic.is_scoring():
        missing.append(MISSING_ANIME_SQL)
    return f"({' OR '.join(missing)})" if missing else ""


def _needs_score_sql() -> str:
    missing_extra = _missing_extra_sql()
    if missing_extra:
        return f"({NEEDS_SCORE_SQL} OR {missing_extra})"
    return NEEDS_SCORE_SQL


ScorePredictor = Callable[[str], Optional[AestheticScores]]

ProgressCallback = Callable[[Dict[str, Any]], None]

AESTHETIC_FINGERPRINT_ERROR = (
    "Image pixels could not be fingerprinted for Aesthetic Scoring; rescan and retry"
)
AESTHETIC_INDEX_STALE_ERROR = (
    "Image pixels changed since the library index was updated; rescan and retry"
)
AESTHETIC_INFERENCE_STALE_ERROR = (
    "Image pixels changed while Aesthetic Scoring was running; rescan and retry"
)
AESTHETIC_PUBLISH_STALE_ERROR = (
    "Image changed before its Aesthetic score could be saved; rescan and retry"
)


class AestheticService:
    """Service wrapper for aesthetic-scoring routes."""

    def __init__(self) -> None:
        self._scoring_lock = threading.Lock()
        self._cancel_requested = False
        self._scoring_state: Dict[str, Any] = {
            "running": False,
            "total": 0,
            "completed": 0,
            "current": "",
            "errors": 0,
            "error": None,
        }

    def get_scoring_progress(self) -> Dict[str, Any]:
        with self._scoring_lock:
            return dict(self._scoring_state)

    def is_scoring_running(self) -> bool:
        with self._scoring_lock:
            return bool(self._scoring_state["running"])

    def request_cancel(self) -> bool:
        with self._scoring_lock:
            if not self._scoring_state["running"]:
                return False
            self._cancel_requested = True
            return True

    def cancel_requested(self) -> bool:
        return self._cancel_requested

    def start_scoring_progress(self, *, total: int) -> None:
        with self._scoring_lock:
            self._cancel_requested = False
            self._scoring_state = {
                "running": True,
                "total": int(total),
                "completed": 0,
                "current": "",
                "errors": 0,
                "error": None,
            }

    def apply_scoring_progress_update(self, update: Dict[str, Any]) -> None:
        with self._scoring_lock:
            self._scoring_state.update(update)

    def finish_scoring_progress(self, *, error: Optional[str] = None) -> None:
        # Surface bg-task crashes to the progress endpoint so the UI can show a
        # toast instead of silently flipping to "completed". Caller passes
        # error=str(exc) when the background task raised; default None means a
        # clean stop (cancellation or natural completion).
        with self._scoring_lock:
            self._scoring_state["running"] = False
            self._scoring_state["current"] = ""
            if error is not None:
                self._scoring_state["error"] = str(error)

    def set_scoring_progress_state(self, state: Dict[str, Any]) -> None:
        with self._scoring_lock:
            self._scoring_state = {
                "running": bool(state.get("running", False)),
                "total": int(state.get("total", 0) or 0),
                "completed": int(state.get("completed", 0) or 0),
                "current": str(state.get("current", "") or ""),
                "errors": int(state.get("errors", 0) or 0),
                "error": state.get("error"),
            }

    def _resolve_image_path(self, *, image_id: int, indexed_path: str) -> Optional[str]:
        resolved_path = resolve_existing_indexed_image_path(indexed_path, backend_file=__file__)
        if resolved_path:
            return resolved_path

        try:
            db.mark_image_unreadable(image_id, "File not found")
        except Exception:
            logger.debug("Failed to mark image %s as unreadable after path resolution failure", image_id)
        return None

    def _compute_content_fingerprint(self, image_path: str) -> Optional[str]:
        try:
            return compute_image_content_fingerprint(image_path)
        except Exception as exc:
            logger.warning("Could not compute content fingerprint for %s: %s", image_path, exc)
            return None

    def _require_content_fingerprint(self, image_path: str) -> str:
        fingerprint = str(self._compute_content_fingerprint(image_path) or "").strip()
        if not fingerprint:
            raise ServiceError(AESTHETIC_FINGERPRINT_ERROR)
        return fingerprint

    def _claim_source_fingerprint(
        self,
        *,
        cursor: sqlite3.Cursor,
        image_id: int,
        image_path: str,
    ) -> str:
        fingerprint = self._require_content_fingerprint(image_path)
        initialized = initialize_image_content_fingerprint(
            cursor,
            image_id=image_id,
            content_fingerprint=fingerprint,
        )
        if not initialized:
            raise ServiceError(AESTHETIC_INDEX_STALE_ERROR)
        return fingerprint

    def _prepare_source_fingerprint(self, *, image_id: int, image_path: str) -> str:
        with db.get_db() as conn:
            return self._claim_source_fingerprint(
                cursor=conn.cursor(),
                image_id=image_id,
                image_path=image_path,
            )

    def _verify_source_fingerprint(self, *, image_path: str, expected_fingerprint: str) -> None:
        if self._require_content_fingerprint(image_path) != expected_fingerprint:
            raise ServiceError(AESTHETIC_INFERENCE_STALE_ERROR)

    def _store_scores(
        self,
        *,
        image_id: int,
        scores: AestheticScores,
        content_fingerprint: str,
    ) -> bool:
        with db.get_db() as conn:
            return write_image_aesthetic_score(
                conn.cursor(),
                image_id=image_id,
                scores=scores,
                content_fingerprint=content_fingerprint,
            )

    def _scored_count(self) -> int:
        try:
            from library_context import current_library_sql

            lib_sql, lib_params = current_library_sql()
            with db.get_db() as conn:
                row = conn.execute(
                    f"SELECT COUNT(*) FROM images WHERE aesthetic_score IS NOT NULL AND {lib_sql}",
                    lib_params,
                ).fetchone()
                return int(row[0] or 0)
        except Exception:
            return 0

    def _outdated_count(self) -> int:
        try:
            from library_context import current_library_sql

            lib_sql, lib_params = current_library_sql()
            with db.get_db() as conn:
                row = conn.execute(
                    f"SELECT COUNT(*) FROM images WHERE aesthetic_score IS NOT NULL "
                    f"AND (aesthetic_version IS NULL OR aesthetic_version < ?) AND {lib_sql}",
                    (AESTHETIC_SCORE_VERSION, *lib_params),
                ).fetchone()
                return int(row[0] or 0)
        except Exception:
            return 0

    def _missing_extra_count(self) -> int:
        """Pictures with a current LAION score that only lack an installed extra score."""
        missing_extra = _missing_extra_sql()
        if not missing_extra:
            return 0
        try:
            from library_context import current_library_sql

            lib_sql, lib_params = current_library_sql()
            with db.get_db() as conn:
                row = conn.execute(
                    f"SELECT COUNT(*) FROM images WHERE NOT {NEEDS_SCORE_SQL} "
                    f"AND {missing_extra} AND {lib_sql}",
                    (AESTHETIC_SCORE_VERSION, *lib_params),
                ).fetchone()
                return int(row[0] or 0)
        except Exception:
            return 0

    def get_status(self, availability_checker: Callable[[], bool]) -> Dict[str, Any]:
        available = availability_checker()
        return {
            "available": available,
            "message": None if available else "Aesthetic predictor dependencies are not installed",
            "scored_count": self._scored_count(),
            # Scores from before the QuickGELU fix: kept, but Score all redoes them.
            "outdated_count": self._outdated_count(),
            # Already scored, but a newly installed optional model has not scored them.
            "missing_extra_count": self._missing_extra_count(),
            # What "Score Aesthetic" would process: the library's unscored images.
            "to_score_count": self.count_images_to_score(force=False),
        }

    def score_single_image(
        self,
        *,
        image_id: int,
        predict_scores: ScorePredictor,
    ) -> Dict[str, Any]:
        with db.get_db() as conn:
            row = conn.execute("SELECT path FROM images WHERE id = ?", (image_id,)).fetchone()
        if not row:
            raise ImageNotFoundError(image_id=image_id)

        indexed_path = str(row["path"] or "")
        image_path = self._resolve_image_path(image_id=image_id, indexed_path=indexed_path)
        if not image_path:
            raise ImageFileNotFoundError(image_id=image_id)

        content_fingerprint = self._prepare_source_fingerprint(
            image_id=image_id,
            image_path=image_path,
        )
        scores = predict_scores(image_path)
        if scores is None:
            raise ServiceError("Scoring failed")
        self._verify_source_fingerprint(
            image_path=image_path,
            expected_fingerprint=content_fingerprint,
        )
        written = self._store_scores(
            image_id=image_id,
            scores=scores,
            content_fingerprint=content_fingerprint,
        )
        if not written:
            raise ServiceError(AESTHETIC_PUBLISH_STALE_ERROR)
        anime = scores.anime
        return {
            "image_id": image_id,
            "aesthetic_score": scores.laion,
            "aesthetic_waifu": scores.waifu,
            "aesthetic_anime": anime.score if anime else None,
            "aesthetic_anime_pct": anime.percentile if anime else None,
            "aesthetic_anime_grade": anime.grade if anime else None,
        }

    def count_images_to_score(self, *, force: bool) -> int:
        from library_context import current_library_sql

        lib_sql, lib_params = current_library_sql()
        with db.get_db() as conn:
            if force:
                row = conn.execute(
                    f"SELECT COUNT(*) FROM images WHERE {lib_sql}",
                    lib_params,
                ).fetchone()
            else:
                row = conn.execute(
                    f"SELECT COUNT(*) FROM images WHERE {_needs_score_sql()} AND {lib_sql}",
                    (AESTHETIC_SCORE_VERSION, *lib_params),
                ).fetchone()
            return int(row[0] or 0)

    def _gpu_cleanup(self) -> None:
        gc.collect()
        try:
            import torch
        except ImportError:
            return  # torch not installed (CPU-only build); nothing to clean
        try:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception as exc:  # noqa: BLE001 — CUDA driver errors must not kill scoring
            logger.warning("torch.cuda.empty_cache failed during aesthetic cleanup: %s", exc)

    def score_batch(
        self,
        *,
        force: bool,
        predict_scores: ScorePredictor,
        progress_callback: Optional[ProgressCallback] = None,
    ) -> None:
        def emit(update: Dict[str, Any]) -> None:
            if progress_callback is not None:
                progress_callback(update)

        emit({"running": True, "completed": 0, "errors": 0, "current": ""})

        # gc_interval was 8 in an earlier draft; that ran gc.collect() + cuda.empty_cache()
        # so often it dropped throughput 5-10x. 50 strikes a safer balance: enough to
        # avoid VRAM pressure from CLIP/aesthetic models, rare enough to amortize the
        # stop-the-world cost.
        gc_interval = 50
        fetch_chunk = 500

        with db.get_db() as conn, db.get_db() as publication_conn:
            from library_context import current_library_sql

            lib_sql, lib_params = current_library_sql()
            if force:
                query = f"SELECT id, path FROM images WHERE {lib_sql}"
                count_query = f"SELECT COUNT(*) FROM images WHERE {lib_sql}"
            else:
                needs_score = _needs_score_sql()
                query = f"SELECT id, path FROM images WHERE {needs_score} AND {lib_sql}"
                count_query = f"SELECT COUNT(*) FROM images WHERE {needs_score} AND {lib_sql}"
                lib_params = (AESTHETIC_SCORE_VERSION, *lib_params)
            count_row = conn.execute(count_query, lib_params).fetchone()
            total = int(count_row[0] or 0) if count_row else 0
            emit({"total": total})

            errors = 0
            completed = 0

            cursor = conn.execute(f"{query} ORDER BY id", lib_params)
            publication_cursor = publication_conn.cursor()
            while True:
                if self._cancel_requested:
                    logger.info("Aesthetic scoring cancelled at %d/%d", completed, total)
                    break

                chunk_rows = cursor.fetchmany(fetch_chunk)
                if not chunk_rows:
                    break

                for row in chunk_rows:
                    if self._cancel_requested:
                        break

                    image_id = int(row["id"])
                    indexed_path = str(row["path"] or "")
                    image_path = self._resolve_image_path(image_id=image_id, indexed_path=indexed_path)
                    emit({"current": image_path or indexed_path})
                    if not image_path:
                        errors += 1
                        completed += 1
                        emit({"errors": errors, "completed": completed})
                        continue
                    try:
                        content_fingerprint = self._claim_source_fingerprint(
                            cursor=publication_cursor,
                            image_id=image_id,
                            image_path=image_path,
                        )
                        publication_conn.commit()
                        scores = predict_scores(image_path)
                        if scores is None:
                            raise ServiceError("Scoring failed")
                        self._verify_source_fingerprint(
                            image_path=image_path,
                            expected_fingerprint=content_fingerprint,
                        )
                        written = write_image_aesthetic_score(
                            publication_cursor,
                            image_id=image_id,
                            scores=scores,
                            content_fingerprint=content_fingerprint,
                        )
                        if not written:
                            raise ServiceError(AESTHETIC_PUBLISH_STALE_ERROR)
                        publication_conn.commit()
                        if scores.anime_failed:
                            # Saved, but the grade stays missing: say so in the run's errors.
                            errors += 1
                            emit({"errors": errors})
                    except Exception as exc:
                        publication_conn.rollback()
                        logger.error("Error scoring %s: %s", image_path, exc)
                        errors += 1
                        emit({"errors": errors})

                    completed += 1
                    emit({"completed": completed})

                    if completed % gc_interval == 0:
                        self._gpu_cleanup()

        emit({"running": False, "current": ""})
        self._gpu_cleanup()
