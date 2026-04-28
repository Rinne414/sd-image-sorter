"""
Aesthetic scoring service for DB-backed aesthetic routes.
"""
from __future__ import annotations

import gc
import logging
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

        emit({
            "running": True,
            "completed": 0,
            "errors": 0,
            "current": "",
        })

        commit_interval = 20
        cache_clear_interval = 50

        with db.get_db() as conn:
            if force:
                rows = conn.execute("SELECT id, path FROM images").fetchall()
            else:
                rows = conn.execute(
                    "SELECT id, path FROM images WHERE aesthetic_score IS NULL"
                ).fetchall()

            emit({"total": len(rows)})
            pending_commits = 0
            errors = 0

            for index, row in enumerate(rows):
                image_id = int(row["id"])
                indexed_path = str(row["path"] or "")
                image_path = self._resolve_image_path(image_id=image_id, indexed_path=indexed_path)
                emit({"current": image_path or indexed_path})
                if not image_path:
                    errors += 1
                    emit({"errors": errors})
                    emit({"completed": index + 1})
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

                emit({"completed": index + 1})

                if pending_commits >= commit_interval:
                    conn.commit()
                    pending_commits = 0

                if (index + 1) % cache_clear_interval == 0:
                    gc.collect()
                    try:
                        import torch
                        if torch.cuda.is_available():
                            torch.cuda.empty_cache()
                    except Exception:
                        pass

            if pending_commits > 0:
                conn.commit()

        emit({
            "running": False,
            "current": "",
        })
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
