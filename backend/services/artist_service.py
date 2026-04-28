"""
Artist identification service for DB-backed artist routes.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Callable, Dict, List, Optional

from fastapi import HTTPException

import database as db
from artist_identifier import get_artist_identifier as default_get_artist_identifier
from image_fingerprint import compute_image_content_fingerprint
from utils.source_paths import resolve_existing_indexed_image_path


logger = logging.getLogger(__name__)

ProgressCallback = Callable[[Dict[str, Any]], None]


class ArtistService:
    """Service wrapper for artist-identification routes."""

    def __init__(self, identifier_getter: Optional[Callable[..., Any]] = None) -> None:
        self._identifier_getter = identifier_getter or default_get_artist_identifier

    def set_identifier_getter(self, identifier_getter: Callable[..., Any]) -> None:
        self._identifier_getter = identifier_getter

    def _identifier(self, *, model_path: Optional[str], model_source: str, threshold: float) -> Any:
        return self._identifier_getter(
            model_path=model_path,
            model_source=model_source,
            threshold=threshold,
        )

    def _get_image_path(self, image_id: int) -> str:
        with db.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT path FROM images WHERE id = ?", (image_id,))
            row = cursor.fetchone()

        if not row:
            raise HTTPException(status_code=404, detail="Image not found")

        indexed_path = str(row[0] or "")
        resolved_path = resolve_existing_indexed_image_path(indexed_path, backend_file=__file__)
        if resolved_path:
            return resolved_path

        try:
            db.mark_image_unreadable(image_id, "File not found")
        except Exception:
            logger.debug("Failed to mark image %s unreadable after path resolution failure", image_id)
        raise HTTPException(status_code=404, detail="Image file not found")

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
            cursor.execute(
                "UPDATE images SET content_fingerprint = COALESCE(?, content_fingerprint) WHERE id = ?",
                (content_fingerprint, image_id),
            )
            cursor.execute(
                """INSERT OR REPLACE INTO artist_predictions
                   (image_id, artist, confidence, top_predictions)
                   VALUES (?, ?, ?, ?)""",
                (image_id, artist, confidence, str(top_predictions)),
            )

    def identify_image(
        self,
        *,
        image_id: int,
        threshold: float,
        top_k: int,
        model_source: str = "huggingface",
        model_path: Optional[str] = None,
    ) -> Dict[str, Any]:
        image_path = self._get_image_path(image_id)

        identifier = self._identifier(
            model_path=model_path,
            model_source=model_source,
            threshold=threshold,
        )
        result = identifier.identify(image_path, top_k=top_k)
        if result.get("error"):
            raise HTTPException(status_code=503, detail=result["error"])

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
            threshold=threshold,
        )

        with db.get_db() as conn:
            cursor = conn.cursor()
            placeholders = ",".join("?" * len(image_ids))
            cursor.execute(
                f"SELECT id, path FROM images WHERE id IN ({placeholders})",
                image_ids,
            )
            image_map = {int(row[0]): str(row[1] or "") for row in cursor.fetchall()}

        emit({
            "step": "identifying",
            "message": f"Identifying {len(image_ids)} image(s)...",
        })

        predictions_to_insert: List[Dict[str, Any]] = []
        results: List[Dict[str, Any]] = []
        processed = 0
        errors = 0

        for image_id in image_ids:
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

                result = identifier.identify(image_path, top_k=top_k)
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

        if predictions_to_insert:
            with db.get_db() as conn:
                cursor = conn.cursor()
                cursor.executemany(
                    "UPDATE images SET content_fingerprint = COALESCE(?, content_fingerprint) WHERE id = ?",
                    [(item["content_fingerprint"], item["image_id"]) for item in predictions_to_insert],
                )
                cursor.executemany(
                    """INSERT OR REPLACE INTO artist_predictions
                       (image_id, artist, confidence, top_predictions)
                       VALUES (?, ?, ?, ?)""",
                    [
                        (
                            item["image_id"],
                            item["artist"],
                            item["confidence"],
                            item["top_predictions"],
                        )
                        for item in predictions_to_insert
                    ],
                )

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

            cursor.execute("SELECT COUNT(*) FROM artist_predictions WHERE artist = 'undefined'")
            undefined_count = int(cursor.fetchone()[0] or 0)

            cursor.execute(
                """
                SELECT artist, COUNT(*) as count, AVG(confidence) as avg_confidence, MAX(confidence) as max_confidence
                FROM artist_predictions
                WHERE artist != 'undefined'
                GROUP BY artist
                ORDER BY count DESC
                """
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
            raise HTTPException(status_code=400, detail="Artist name is required")

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
