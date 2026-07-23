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
    content_fingerprint: Optional[str],
) -> None:
    """Store an aesthetic score and advance the source fingerprint when known."""
    cursor.execute(
        """
        UPDATE images
        SET aesthetic_score = ?,
            content_fingerprint = COALESCE(?, content_fingerprint)
        WHERE id = ?
        """,
        (aesthetic_score, content_fingerprint, image_id),
    )


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


def write_image_content_fingerprints(
    cursor: sqlite3.Cursor,
    updates: Iterable[tuple[Optional[str], int]],
) -> None:
    """Advance image content fingerprints for a batch of derived writes."""
    cursor.executemany(
        """
        UPDATE images
        SET content_fingerprint = COALESCE(?, content_fingerprint)
        WHERE id = ?
        """,
        updates,
    )


def write_artist_prediction(
    cursor: sqlite3.Cursor,
    *,
    image_id: int,
    artist: str,
    confidence: float,
    top_predictions: Sequence[dict[str, Any]],
    content_fingerprint: Optional[str],
) -> None:
    """Store artist prediction state and its associated source fingerprint."""
    write_image_content_fingerprint(
        cursor,
        image_id=image_id,
        content_fingerprint=content_fingerprint,
    )
    cursor.execute(
        """INSERT OR REPLACE INTO artist_predictions
           (image_id, artist, confidence, top_predictions)
           VALUES (?, ?, ?, ?)""",
        (image_id, artist, confidence, str(list(top_predictions))),
    )


def write_artist_predictions(
    cursor: sqlite3.Cursor,
    predictions: Iterable[dict[str, Any]],
) -> None:
    """Store a batch of artist predictions and associated source fingerprints."""
    rows: list[tuple[int, str, float, str]] = []
    fingerprint_updates: list[tuple[Optional[str], int]] = []

    for item in predictions:
        image_id = int(item["image_id"])
        top_predictions = item.get("top_predictions")
        if isinstance(top_predictions, str):
            serialized_top_predictions = top_predictions
        else:
            serialized_top_predictions = str(list(top_predictions or []))
        rows.append(
            (
                image_id,
                str(item.get("artist") or "undefined"),
                float(item.get("confidence") or 0.0),
                serialized_top_predictions,
            )
        )
        fingerprint_updates.append((item.get("content_fingerprint"), image_id))

    if not rows:
        return

    write_image_content_fingerprints(cursor, fingerprint_updates)
    cursor.executemany(
        """INSERT OR REPLACE INTO artist_predictions
           (image_id, artist, confidence, top_predictions)
           VALUES (?, ?, ?, ?)""",
        rows,
    )
