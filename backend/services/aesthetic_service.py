"""
Aesthetic scoring service for DB-backed aesthetic routes.
"""
from __future__ import annotations

import gc
import logging
import threading
from typing import Any, Callable, Dict, Optional

import database as db
from exceptions import ImageFileNotFoundError, ImageNotFoundError, ServiceError
from image_fingerprint import compute_image_content_fingerprint
from services.derived_state_service import write_image_aesthetic_score
from utils.source_paths import resolve_existing_indexed_image_path


logger = logging.getLogger(__name__)

ProgressCallback = Callable[[Dict[str, Any]], None]


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

    def _scored_count(self) -> int:
        try:
            with db.get_db() as conn:
                row = conn.execute(
                    "SELECT COUNT(*) FROM images WHERE aesthetic_score IS NOT NULL"
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
        }

    def score_single_image(
        self,
        *,
        image_id: int,
        predict_score: Callable[[str], Optional[float]],
    ) -> Dict[str, Any]:
        with db.get_db() as conn:
            row = conn.execute("SELECT path FROM images WHERE id = ?", (image_id,)).fetchone()
            if not row:
                raise ImageNotFoundError(image_id=image_id)

            indexed_path = str(row["path"] or "")
            image_path = self._resolve_image_path(image_id=image_id, indexed_path=indexed_path)
            if not image_path:
                raise ImageFileNotFoundError(image_id=image_id)

            score = predict_score(image_path)
            if score is None:
                raise ServiceError("Scoring failed")

            write_image_aesthetic_score(
                conn,
                image_id=image_id,
                aesthetic_score=score,
                content_fingerprint=self._compute_content_fingerprint(image_path),
            )
            return {"image_id": image_id, "aesthetic_score": score}

    def count_images_to_score(self, *, force: bool) -> int:
        with db.get_db() as conn:
            if force:
                row = conn.execute("SELECT COUNT(*) FROM images").fetchone()
            else:
                row = conn.execute(
                    "SELECT COUNT(*) FROM images WHERE aesthetic_score IS NULL"
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
        predict_score: Callable[[str], Optional[float]],
        progress_callback: Optional[ProgressCallback] = None,
    ) -> None:
        def emit(update: Dict[str, Any]) -> None:
            if progress_callback is not None:
                progress_callback(update)

        emit({"running": True, "completed": 0, "errors": 0, "current": ""})

        commit_interval = 20
        # gc_interval was 8 in an earlier draft; that ran gc.collect() + cuda.empty_cache()
        # so often it dropped throughput 5-10x. 50 strikes a safer balance: enough to
        # avoid VRAM pressure from CLIP/aesthetic models, rare enough to amortize the
        # stop-the-world cost.
        gc_interval = 50
        fetch_chunk = 500

        with db.get_db() as conn:
            query = "SELECT id, path FROM images" if force else "SELECT id, path FROM images WHERE aesthetic_score IS NULL"
            count_query = "SELECT COUNT(*) FROM images" if force else "SELECT COUNT(*) FROM images WHERE aesthetic_score IS NULL"
            count_row = conn.execute(count_query).fetchone()
            total = int(count_row[0] or 0) if count_row else 0
            emit({"total": total})

            pending_commits = 0
            errors = 0
            completed = 0

            cursor = conn.execute(f"{query} ORDER BY id")
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
                        score = predict_score(image_path)
                        if score is not None:
                            write_image_aesthetic_score(
                                conn,
                                image_id=image_id,
                                aesthetic_score=score,
                                content_fingerprint=self._compute_content_fingerprint(image_path),
                            )
                            pending_commits += 1
                        else:
                            errors += 1
                            emit({"errors": errors})
                    except Exception as exc:
                        logger.error("Error scoring %s: %s", image_path, exc)
                        errors += 1
                        emit({"errors": errors})

                    completed += 1
                    emit({"completed": completed})

                    if pending_commits >= commit_interval:
                        conn.commit()
                        pending_commits = 0

                    if completed % gc_interval == 0:
                        self._gpu_cleanup()

                if pending_commits > 0:
                    conn.commit()
                    pending_commits = 0

        emit({"running": False, "current": ""})
        self._gpu_cleanup()
