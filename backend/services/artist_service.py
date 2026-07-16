"""
Artist identification service for DB-backed artist routes.
"""
from __future__ import annotations

import gc
import logging
import os
import threading
import time
from typing import Any, Callable, Dict, List, Optional

from exceptions import ImageFileNotFoundError, ImageNotFoundError, ServiceError, ValidationError

import database as db
from artist_identifier import (
    ARTIST_THRESHOLD_DEFAULT,
    get_artist_identifier as default_get_artist_identifier,
)
from image_fingerprint import compute_image_content_fingerprint
from services.derived_state_service import (
    write_artist_prediction,
    write_artist_predictions,
)
from utils.source_paths import resolve_existing_indexed_image_path


logger = logging.getLogger(__name__)

ProgressCallback = Callable[[Dict[str, Any]], None]
ARTIST_IMAGE_LOOKUP_CHUNK_SIZE = 500


class _E2EArtistIdentifierStub:
    """Small deterministic artist identifier for Playwright full-flow tests only."""

    def __init__(self, *, threshold: float) -> None:
        self.threshold = float(threshold)

    def identify(self, image_path: str, top_k: int = 5) -> Dict[str, Any]:
        return self.identify_with_threshold(
            image_path=image_path,
            top_k=top_k,
            threshold=self.threshold,
        )

    def identify_with_threshold(
        self,
        image_path: str,
        top_k: int,
        threshold: float,
    ) -> Dict[str, Any]:
        stem = os.path.splitext(os.path.basename(image_path))[0]
        artist = "fixture_artist"
        confidence = 0.97
        top_predictions = [
            {"artist": artist, "confidence": confidence},
            {"artist": f"fixture_{stem[:24] or 'image'}", "confidence": 0.61},
            {"artist": "undefined", "confidence": 0.01},
        ][: max(1, int(top_k or 1))]
        return {
            "artist": artist if confidence >= threshold else "undefined",
            "confidence": confidence,
            "top_predictions": top_predictions,
            "model_loaded": True,
        }


def _e2e_artist_identifier_getter(**kwargs: Any) -> _E2EArtistIdentifierStub:
    return _E2EArtistIdentifierStub(threshold=float(kwargs.get("threshold") or 0.0))


class ArtistService:
    """Service wrapper for artist-identification routes."""

    def __init__(self, identifier_getter: Optional[Callable[..., Any]] = None) -> None:
        self._identifier_getter = identifier_getter or default_get_artist_identifier
        self._batch_lock = threading.Lock()
        self._cancel_requested = False
        self._batch_progress: Dict[str, Any] = self._new_batch_progress_state()

    @staticmethod
    def _new_batch_progress_state() -> Dict[str, Any]:
        return {
            "running": False,
            "total": 0,
            "processed": 0,
            "errors": 0,
            "results": [],
            "step": "idle",
            "message": "",
            "current_item": None,
            "started_at": None,
            "updated_at": None,
        }

    def get_batch_progress(self) -> Dict[str, Any]:
        with self._batch_lock:
            snapshot = dict(self._batch_progress)
            snapshot["results"] = list(self._batch_progress.get("results", []))
            return snapshot

    def is_batch_running(self) -> bool:
        with self._batch_lock:
            return bool(self._batch_progress["running"])

    def request_cancel(self) -> bool:
        with self._batch_lock:
            if not self._batch_progress["running"]:
                return False
            self._cancel_requested = True
            return True

    def cancel_requested(self) -> bool:
        return self._cancel_requested

    def start_batch_progress(self, *, total: int) -> None:
        self._cancel_requested = False
        now = time.time()
        with self._batch_lock:
            self._batch_progress = {
                "running": True,
                "total": int(total),
                "processed": 0,
                "errors": 0,
                "results": [],
                "step": "starting",
                "message": "Preparing artist identification...",
                "current_item": None,
                "started_at": now,
                "updated_at": now,
            }

    def apply_batch_progress_update(self, update: Dict[str, Any]) -> None:
        with self._batch_lock:
            if "step" in update:
                self._batch_progress["step"] = update["step"]
            if "message" in update:
                self._batch_progress["message"] = update["message"]
            if "current_item" in update:
                self._batch_progress["current_item"] = update["current_item"]
            if "result" in update:
                self._batch_progress["results"].append(update["result"])
            if "errors_delta" in update:
                self._batch_progress["errors"] += int(update["errors_delta"] or 0)
            if "processed_delta" in update:
                self._batch_progress["processed"] += int(update["processed_delta"] or 0)
            if "running" in update:
                self._batch_progress["running"] = bool(update["running"])
            if "total" in update:
                self._batch_progress["total"] = int(update["total"] or 0)
            self._batch_progress["updated_at"] = time.time()

    def finish_batch_progress_done(self, result: Dict[str, Any]) -> None:
        with self._batch_lock:
            self._batch_progress["running"] = False
            self._batch_progress["step"] = "done"
            self._batch_progress["message"] = (
                f"Completed artist identification: {result['processed']}/{result['total']} processed"
                + (f", {result['errors']} failed." if result["errors"] else ".")
            )
            self._batch_progress["current_item"] = None
            self._batch_progress["updated_at"] = time.time()

    def finish_batch_progress_error(self, exc: Exception) -> None:
        with self._batch_lock:
            self._batch_progress["running"] = False
            self._batch_progress["step"] = "error"
            self._batch_progress["message"] = f"Artist identification failed: {exc}"
            self._batch_progress["current_item"] = None
            self._batch_progress["updated_at"] = time.time()

    def set_batch_progress_state(self, state: Dict[str, Any]) -> None:
        normalized = self._new_batch_progress_state()
        normalized.update({
            "running": bool(state.get("running", False)),
            "total": int(state.get("total", 0) or 0),
            "processed": int(state.get("processed", 0) or 0),
            "errors": int(state.get("errors", 0) or 0),
            "results": list(state.get("results", []) or []),
            "step": state.get("step"),
            "message": state.get("message"),
            "current_item": state.get("current_item"),
            "started_at": state.get("started_at"),
            "updated_at": state.get("updated_at"),
        })
        with self._batch_lock:
            self._batch_progress = normalized

    def set_identifier_getter(self, identifier_getter: Callable[..., Any]) -> None:
        self._identifier_getter = identifier_getter

    def _identifier(
        self,
        *,
        model_path: Optional[str],
        model_source: str,
        use_gpu: Optional[bool],
    ) -> Any:
        return self._identifier_getter(
            model_path=model_path,
            model_source=model_source,
            threshold=ARTIST_THRESHOLD_DEFAULT,
            use_gpu=use_gpu,
        )

    def _get_image_path(self, image_id: int) -> str:
        with db.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT path FROM images WHERE id = ?", (image_id,))
            row = cursor.fetchone()

        if not row:
            raise ImageNotFoundError(image_id=image_id)

        indexed_path = str(row[0] or "")
        resolved_path = resolve_existing_indexed_image_path(indexed_path, backend_file=__file__)
        if resolved_path:
            return resolved_path

        try:
            db.mark_image_unreadable(image_id, "File not found")
        except Exception:
            logger.debug("Failed to mark image %s unreadable after path resolution failure", image_id)
        raise ImageFileNotFoundError(image_id=image_id)

    def _compute_content_fingerprint(self, image_path: str) -> Optional[str]:
        try:
            return compute_image_content_fingerprint(image_path)
        except Exception as exc:
            logger.warning("Could not compute content fingerprint for %s: %s", image_path, exc)
            return None

    def _store_prediction(
        self,
        *,
        image_id: int,
        artist: str,
        confidence: float,
        top_predictions: List[dict],
        content_fingerprint: Optional[str],
    ) -> None:
        with db.get_db() as conn:
            cursor = conn.cursor()
            write_artist_prediction(
                cursor,
                image_id=image_id,
                artist=artist,
                confidence=confidence,
                top_predictions=top_predictions,
                content_fingerprint=content_fingerprint,
            )

    def identify_image(
        self,
        *,
        image_id: int,
        threshold: float,
        top_k: int,
        model_source: str = "huggingface",
        model_path: Optional[str] = None,
        use_gpu: Optional[bool] = None,
    ) -> Dict[str, Any]:
        image_path = self._get_image_path(image_id)

        identifier = self._identifier(
            model_path=model_path,
            model_source=model_source,
            use_gpu=use_gpu,
        )
        result = identifier.identify_with_threshold(image_path, top_k, threshold)
        if result.get("error"):
            raise ServiceError(result["error"])

        self._store_prediction(
            image_id=image_id,
            artist=result["artist"],
            confidence=float(result["confidence"]),
            top_predictions=list(result["top_predictions"]),
            content_fingerprint=self._compute_content_fingerprint(image_path),
        )

        return {
            "image_id": image_id,
            "artist": result["artist"],
            "confidence": float(result["confidence"]),
            "top_predictions": list(result["top_predictions"]),
            "model_loaded": bool(result.get("model_loaded")),
            "experimental": True,
        }

    def run_batch_identification(
        self,
        *,
        image_ids: List[int],
        threshold: float,
        top_k: int,
        model_source: str = "huggingface",
        model_path: Optional[str] = None,
        use_gpu: Optional[bool] = None,
        progress_callback: Optional[ProgressCallback] = None,
    ) -> Dict[str, Any]:
        def emit(update: Dict[str, Any]) -> None:
            if progress_callback is not None:
                progress_callback(update)

        emit({
            "step": "loading_runtime",
            "message": "Loading artist runtime...",
        })

        identifier = self._identifier(
            model_path=model_path,
            model_source=model_source,
            use_gpu=use_gpu,
        )

        with db.get_db() as conn:
            cursor = conn.cursor()
            image_map: Dict[int, str] = {}
            for start in range(0, len(image_ids), ARTIST_IMAGE_LOOKUP_CHUNK_SIZE):
                chunk_ids = image_ids[start:start + ARTIST_IMAGE_LOOKUP_CHUNK_SIZE]
                if not chunk_ids:
                    continue
                placeholders = ",".join("?" * len(chunk_ids))
                cursor.execute(
                    f"SELECT id, path FROM images WHERE id IN ({placeholders})",
                    chunk_ids,
                )
                image_map.update({int(row[0]): str(row[1] or "") for row in cursor.fetchall()})

        emit({
            "step": "identifying",
            "message": f"Identifying {len(image_ids)} image(s)...",
        })

        predictions_to_insert: List[Dict[str, Any]] = []
        results: List[Dict[str, Any]] = []
        processed = 0
        errors = 0

        for image_id in image_ids:
            if self._cancel_requested:
                logger.info("Artist batch cancelled at %d/%d", processed, len(image_ids))
                break
            try:
                if image_id not in image_map:
                    raise FileNotFoundError(f"Image {image_id} not found in database")

                indexed_path = image_map[image_id]
                image_path = resolve_existing_indexed_image_path(indexed_path, backend_file=__file__)
                current_item = os.path.basename(image_path or indexed_path)
                emit({
                    "current_item": current_item,
                    "message": f"Identifying {current_item}",
                })

                if not image_path:
                    try:
                        db.mark_image_unreadable(image_id, "File not found")
                    except Exception:
                        logger.debug("Failed to mark image %s unreadable in batch identification", image_id)
                    raise FileNotFoundError(f"Image file not found for image {image_id}")

                result = identifier.identify_with_threshold(image_path, top_k, threshold)
                if result.get("error"):
                    raise RuntimeError(result["error"])

                prediction = {
                    "image_id": image_id,
                    "artist": result["artist"],
                    "confidence": float(result["confidence"]),
                    "top_predictions": str(result["top_predictions"]),
                    "content_fingerprint": self._compute_content_fingerprint(image_path),
                }
                predictions_to_insert.append(prediction)

                public_result = {
                    "image_id": image_id,
                    "artist": result["artist"],
                    "confidence": float(result["confidence"]),
                }
                results.append(public_result)
                emit({"result": public_result})
            except Exception as exc:
                logger.error("Error processing image %s: %s", image_id, exc)
                errors += 1
                emit({"errors_delta": 1})
            finally:
                processed += 1
                emit({"processed_delta": 1})
                if processed % 8 == 0:
                    gc.collect()
                    try:
                        import torch
                        if torch.cuda.is_available():
                            torch.cuda.empty_cache()
                    except Exception:
                        pass

        if predictions_to_insert:
            with db.get_db() as conn:
                cursor = conn.cursor()
                write_artist_predictions(cursor, predictions_to_insert)

        return {
            "total": len(image_ids),
            "processed": processed,
            "errors": errors,
            "results": results,
        }

    def get_stats(self) -> Dict[str, Any]:
        with db.get_db() as conn:
            cursor = conn.cursor()

            cursor.execute("SELECT COUNT(*) FROM images")
            total_images = int(cursor.fetchone()[0] or 0)

            cursor.execute("SELECT COUNT(*) FROM artist_predictions")
            identified_images = int(cursor.fetchone()[0] or 0)

            # Sub-threshold rows (legacy data written before the identify
            # pipeline enforced its confidence floor) fold into "undefined"
            # instead of surfacing 0.1%-confidence noise as a found artist
            # (v3.5.0 audit).
            cursor.execute(
                "SELECT COUNT(*) FROM artist_predictions WHERE artist = 'undefined' OR confidence < ?",
                (ARTIST_THRESHOLD_DEFAULT,),
            )
            undefined_count = int(cursor.fetchone()[0] or 0)

            cursor.execute(
                """
                SELECT artist, COUNT(*) as count, AVG(confidence) as avg_confidence, MAX(confidence) as max_confidence
                FROM artist_predictions
                WHERE artist != 'undefined' AND confidence >= ?
                GROUP BY artist
                ORDER BY count DESC
                """,
                (ARTIST_THRESHOLD_DEFAULT,),
            )
            artist_counts: Dict[str, int] = {}
            artist_stats: Dict[str, Dict[str, float]] = {}
            for row in cursor.fetchall():
                artist = str(row[0] or "")
                artist_counts[artist] = int(row[1] or 0)
                artist_stats[artist] = {
                    "count": float(row[1] or 0),
                    "avg_confidence": float(row[2] or 0.0),
                    "max_confidence": float(row[3] or 0.0),
                }

        return {
            "total_images": total_images,
            "identified_images": identified_images,
            "undefined_count": undefined_count,
            "artist_counts": artist_counts,
            "artist_stats": artist_stats,
        }

    def get_artist_images(self, *, artist_name: str, limit: int, offset: int) -> Dict[str, Any]:
        safe_artist = str(artist_name or "").strip()
        if not safe_artist:
            raise ValidationError("Artist name is required", field="artist_name")

        with db.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT COUNT(*)
                FROM artist_predictions ap
                WHERE ap.artist = ?
                """,
                (safe_artist,),
            )
            total = int(cursor.fetchone()[0] or 0)

            cursor.execute(
                """
                SELECT i.id, i.filename, i.path, ap.artist, ap.confidence
                FROM artist_predictions ap
                INNER JOIN images i ON i.id = ap.image_id
                WHERE ap.artist = ?
                ORDER BY ap.confidence DESC, COALESCE(i.library_order_time, i.created_at) DESC, i.id DESC
                LIMIT ?
                OFFSET ?
                """,
                (safe_artist, limit, offset),
            )
            rows = cursor.fetchall()

        images = [
            {
                "image_id": int(row[0]),
                "filename": str(row[1] or ""),
                "path": str(row[2] or ""),
                "artist": str(row[3] or ""),
                "confidence": float(row[4] or 0.0),
                "confidence_percent": round(float(row[4] or 0.0) * 100, 1),
            }
            for row in rows
        ]

        return {
            "artist": safe_artist,
            "total": total,
            "limit": limit,
            "offset": offset,
            "has_more": (offset + len(images)) < total,
            "images": images,
        }

    def list_artists(self) -> Dict[str, Any]:
        identifier = self._identifier_getter()
        return {"artists": identifier.get_artists_list()}

    def clear_predictions(self) -> Dict[str, str]:
        with db.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM artist_predictions")

        return {"message": "All artist predictions cleared"}
