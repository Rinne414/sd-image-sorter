"""
Shared database writers for image-derived state.

Derived state is any cached result computed from image pixels or AI analysis.
Keep direct writes here so content_fingerprint updates and cache writes do not
drift across feature services. Database-owned invalidation stays in database.py
to avoid a circular dependency through services.__init__.
"""
from __future__ import annotations

import sqlite3
from typing import Any, Iterable, Optional, Sequence


def write_image_embeddings(
    cursor: sqlite3.Cursor,
    updates: Iterable[tuple[bytes, str, int]],
) -> list[int]:
    """Store only embeddings that still match their source fingerprint."""
    written_image_ids: list[int] = []
    for embedding, content_fingerprint, image_id in updates:
        fingerprint = str(content_fingerprint).strip()
        if not fingerprint:
            raise ValueError("content_fingerprint must be non-empty for an embedding")
        cursor.execute(
            """
            UPDATE images
            SET embedding = ?,
                content_fingerprint = ?
            WHERE id = ? AND content_fingerprint = ?
            """,
            (embedding, fingerprint, image_id, fingerprint),
        )
        if cursor.rowcount == 1:
            written_image_ids.append(image_id)
    return written_image_ids


def initialize_image_content_fingerprint(
    cursor: sqlite3.Cursor,
    *,
    image_id: int,
    content_fingerprint: str,
) -> bool:
    """Claim a missing image fingerprint without overwriting a known value."""
    fingerprint = str(content_fingerprint).strip()
    if not fingerprint:
        raise ValueError("content_fingerprint must be non-empty")

    cursor.execute(
        """
        UPDATE images
        SET content_fingerprint = ?
        WHERE id = ? AND content_fingerprint IS NULL
        """,
        (fingerprint, image_id),
    )
    if cursor.rowcount == 1:
        return True

    row = cursor.execute(
        "SELECT content_fingerprint FROM images WHERE id = ?",
        (image_id,),
    ).fetchone()
    return bool(row and row["content_fingerprint"] == fingerprint)


def write_image_aesthetic_score(
    cursor: sqlite3.Cursor,
    *,
    image_id: int,
    aesthetic_score: float,
    content_fingerprint: str,
) -> bool:
    """Store an aesthetic score only while its source fingerprint is current."""
    fingerprint = str(content_fingerprint or "").strip()
    if not fingerprint:
        raise ValueError("content_fingerprint must be non-empty for an Aesthetic score")

    cursor.execute(
        """
        UPDATE images
        SET aesthetic_score = ?,
            content_fingerprint = ?
        WHERE id = ? AND content_fingerprint = ?
        """,
        (aesthetic_score, fingerprint, image_id, fingerprint),
    )
    return cursor.rowcount == 1


def write_image_content_fingerprint(
    cursor: sqlite3.Cursor,
    *,
    image_id: int,
    content_fingerprint: Optional[str],
) -> None:
    """Advance only the image content fingerprint, preserving existing value on None."""
    cursor.execute(
        """
        UPDATE images
        SET content_fingerprint = COALESCE(?, content_fingerprint)
        WHERE id = ?
        """,
        (content_fingerprint, image_id),
    )


def write_artist_prediction(
    cursor: sqlite3.Cursor,
    *,
    image_id: int,
    artist: str,
    confidence: float,
    top_predictions: Sequence[dict[str, Any]],
    content_fingerprint: str,
) -> bool:
    """Store an Artist prediction only while its source fingerprint is current."""
    fingerprint = str(content_fingerprint).strip()
    if not fingerprint:
        raise ValueError("content_fingerprint must be non-empty for an Artist prediction")
    cursor.execute(
        """
        INSERT OR REPLACE INTO artist_predictions
            (image_id, artist, confidence, top_predictions)
        SELECT ?, ?, ?, ?
        WHERE EXISTS (
            SELECT 1
            FROM images
            WHERE id = ? AND content_fingerprint = ?
        )
        """,
        (
            image_id,
            artist,
            confidence,
            str(list(top_predictions)),
            image_id,
            fingerprint,
        ),
    )
    return cursor.rowcount == 1


def write_artist_predictions(
    cursor: sqlite3.Cursor,
    predictions: Iterable[dict[str, Any]],
) -> list[int]:
    """Store and return Artist predictions whose source fingerprints remain current."""
    written_image_ids: list[int] = []
    for item in predictions:
        image_id = int(item["image_id"])
        top_predictions = item.get("top_predictions")
        if isinstance(top_predictions, str):
            raise TypeError("top_predictions must be a sequence of prediction objects")
        else:
            normalized_top_predictions = list(top_predictions or [])
        fingerprint = str(item.get("content_fingerprint") or "").strip()
        if write_artist_prediction(
            cursor,
            image_id=image_id,
            artist=str(item.get("artist") or "undefined"),
            confidence=float(item.get("confidence") or 0.0),
            top_predictions=normalized_top_predictions,
            content_fingerprint=fingerprint,
        ):
            written_image_ids.append(image_id)
    return written_image_ids
