"""SQLite access for ``image_style_vectors`` (migration 050).

Vectors are stored L2-normalised as float16: the Kaloscope head-BN feature has
a few dimensions in the 1e8 range that overflow float16 raw, while the unit
vector round-trips with a pairwise cosine error below 1e-4 (measured on 1,964
library images). Only the direction is ever used (cosine / PCA / UMAP), so
the norm is not kept.

Every write is gated on the image's current ``content_fingerprint``, the same
rule ``write_artist_prediction`` follows: a vector is never stored for pixels
the scan no longer knows.
"""

from __future__ import annotations

import sqlite3
from typing import Iterable, Optional, Sequence

import numpy as np

STYLE_VECTOR_DTYPE = "float16"
_LOOKUP_CHUNK = 500


def pack_style_vector(vector) -> tuple[bytes, int, str]:
    """Return (blob, dim, dtype) for a finite, non-zero vector."""
    array = np.asarray(vector, dtype=np.float32).reshape(-1)
    if array.size == 0 or not np.all(np.isfinite(array)):
        raise ValueError("style vector must be non-empty and finite")
    norm = float(np.linalg.norm(array))
    if norm <= 0.0:
        raise ValueError("style vector must not be all zeros")
    unit = (array / norm).astype(np.float16)
    return unit.tobytes(), int(array.size), STYLE_VECTOR_DTYPE


def unpack_style_vector(blob: bytes, dim: int, dtype: str) -> np.ndarray:
    """Decode a stored vector back to float32 (unit length up to float16 error)."""
    array = np.frombuffer(bytes(blob), dtype=np.dtype(str(dtype))).astype(np.float32)
    if array.size != int(dim):
        raise ValueError(f"stored vector has {array.size} values, expected {dim}")
    return array


def upsert_style_vector(
    cursor: sqlite3.Cursor,
    *,
    image_id: int,
    space: str,
    model_version: str,
    content_fingerprint: str,
    vector,
) -> bool:
    """Store a vector only while ``content_fingerprint`` is still the image's."""
    fingerprint = str(content_fingerprint or "").strip()
    if not fingerprint:
        raise ValueError("content_fingerprint must be non-empty for a style vector")
    blob, dim, dtype = pack_style_vector(vector)
    cursor.execute(
        """
        INSERT INTO image_style_vectors
            (image_id, space, model_version, content_fingerprint, dim, dtype, vector, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now')
        WHERE EXISTS (
            SELECT 1 FROM images WHERE id = ? AND content_fingerprint = ?
        )
        ON CONFLICT(image_id, space) DO UPDATE SET
            model_version = excluded.model_version,
            content_fingerprint = excluded.content_fingerprint,
            dim = excluded.dim,
            dtype = excluded.dtype,
            vector = excluded.vector,
            updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
        """,
        (
            int(image_id),
            str(space),
            str(model_version),
            fingerprint,
            dim,
            dtype,
            blob,
            int(image_id),
            fingerprint,
        ),
    )
    return cursor.rowcount == 1


# A vector is pending when the image has none for this space, when it came
# from other weights, or when the scan has recorded different pixels since.
_PENDING_CLAUSE = """
    (v.image_id IS NULL
     OR v.model_version != ?
     OR i.content_fingerprint IS NULL
     OR v.content_fingerprint != i.content_fingerprint)
"""


def pending_style_vector_rows(
    cursor: sqlite3.Cursor,
    *,
    space: str,
    model_version: str,
    library_sql: str,
    library_params: Sequence,
    image_ids: Optional[Iterable[int]] = None,
) -> list[tuple[int, str, Optional[str], Optional[str]]]:
    """Return (image_id, path, stored_fingerprint, stored_version) rows that need a vector.

    ``stored_*`` describe the vector the image already has (None when it has
    none) so the worker can keep it when the pixels turn out unchanged.
    """
    base = f"""
        SELECT i.id, i.path, v.content_fingerprint, v.model_version
        FROM images i
        LEFT JOIN image_style_vectors v ON v.image_id = i.id AND v.space = ?
        WHERE {library_sql}
          AND COALESCE(i.is_readable, 1) = 1
          AND {_PENDING_CLAUSE}
    """
    params: list = [str(space), *library_params, str(model_version)]
    if image_ids is None:
        rows = cursor.execute(base + " ORDER BY i.id", params).fetchall()
        return [(int(row[0]), str(row[1] or ""), row[2], row[3]) for row in rows]

    wanted = sorted({int(value) for value in image_ids})
    out: list[tuple[int, str, Optional[str], Optional[str]]] = []
    for start in range(0, len(wanted), _LOOKUP_CHUNK):
        chunk = wanted[start : start + _LOOKUP_CHUNK]
        placeholders = ",".join("?" * len(chunk))
        rows = cursor.execute(
            base + f" AND i.id IN ({placeholders}) ORDER BY i.id",
            [*params, *chunk],
        ).fetchall()
        out.extend((int(row[0]), str(row[1] or ""), row[2], row[3]) for row in rows)
    return out


def style_vector_counts(
    cursor: sqlite3.Cursor,
    *,
    space: str,
    model_version: str,
    library_sql: str,
    library_params: Sequence,
) -> dict:
    """Coverage of one space over the current library's readable images."""
    row = cursor.execute(
        f"""
        SELECT
            COUNT(*) AS images,
            SUM(CASE WHEN v.image_id IS NOT NULL THEN 1 ELSE 0 END) AS vectors,
            SUM(CASE WHEN {_PENDING_CLAUSE} THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN v.image_id IS NOT NULL
                          AND (i.content_fingerprint IS NULL
                               OR v.content_fingerprint != i.content_fingerprint) THEN 1 ELSE 0 END) AS stale,
            SUM(CASE WHEN v.image_id IS NOT NULL AND v.model_version != ? THEN 1 ELSE 0 END) AS other_version
        FROM images i
        LEFT JOIN image_style_vectors v ON v.image_id = i.id AND v.space = ?
        WHERE {library_sql}
          AND COALESCE(i.is_readable, 1) = 1
        """,
        (str(model_version), str(model_version), str(space), *library_params),
    ).fetchone()
    return {
        "images": int(row[0] or 0),
        "vectors": int(row[1] or 0),
        "pending": int(row[2] or 0),
        "stale": int(row[3] or 0),
        "other_version": int(row[4] or 0),
    }
