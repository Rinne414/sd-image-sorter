"""Video columns of the images table (migration 065).

The generic writers (scan upsert, metadata updates) do not know these columns;
the scan marks a new or changed video 'pending' here and the background video
indexer fills the rest. Imports only db_core / db_helpers / stdlib.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional

from db_core import _invalidate_facet_caches, get_db
from db_helpers import _path_query_match_clause

PENDING = "pending"
READY = "ready"
UNREADABLE = "unreadable"
_CHUNK = 200


def mark_videos_pending(paths: Iterable[str]) -> int:
    """Mark these (video) rows as waiting for the indexer; clears old facts."""
    wanted = [p for p in paths if p]
    changed = 0
    with get_db() as conn:
        for start in range(0, len(wanted), _CHUNK):
            clause, params = _path_query_match_clause(wanted[start : start + _CHUNK])
            if not clause:
                continue
            cursor = conn.execute(
                "UPDATE images SET video_probe_state = ?, video_probe_error = NULL, "
                "duration_seconds = NULL, video_codec = NULL, video_fps = NULL, "
                "video_has_audio = NULL "
                f"WHERE media_type = 'video' AND ({clause})",
                (PENDING, *params),
            )
            changed += cursor.rowcount or 0
    return changed


def pending_videos(limit: int, after_id: int = 0) -> List[Dict[str, Any]]:
    """Videos waiting to be probed, oldest id first."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, path FROM images WHERE media_type = 'video' "
            "AND video_probe_state = ? AND id > ? ORDER BY id LIMIT ?",
            (PENDING, after_id, limit),
        ).fetchall()
    return [{"id": int(row[0]), "path": str(row[1])} for row in rows]


def save_video_facts(
    image_id: int,
    *,
    state: str,
    duration: Optional[float] = None,
    codec: Optional[str] = None,
    fps: Optional[float] = None,
    has_audio: Optional[bool] = None,
    error: Optional[str] = None,
) -> None:
    with get_db() as conn:
        conn.execute(
            "UPDATE images SET video_probe_state = ?, duration_seconds = ?, "
            "video_codec = ?, video_fps = ?, video_has_audio = ?, video_probe_error = ? "
            "WHERE id = ?",
            (
                state,
                duration,
                codec,
                fps,
                None if has_audio is None else int(bool(has_audio)),
                error,
                image_id,
            ),
        )
    _invalidate_facet_caches()


def video_counts() -> Dict[str, int]:
    """How many videos are indexed, and how many still wait for probing."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT COUNT(*), "
            "SUM(CASE WHEN video_probe_state = 'pending' THEN 1 ELSE 0 END), "
            "SUM(CASE WHEN video_probe_state = 'unreadable' THEN 1 ELSE 0 END) "
            "FROM images WHERE media_type = 'video'"
        ).fetchone()
    return {
        "videos": int(row[0] or 0),
        "pending": int(row[1] or 0),
        "unreadable": int(row[2] or 0),
    }


def get_video_row(image_id: int) -> Optional[Dict[str, Any]]:
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, path, filename, media_type, width, height, duration_seconds, "
            "video_codec, video_fps, video_has_audio, video_probe_state, video_probe_error "
            "FROM images WHERE id = ?",
            (image_id,),
        ).fetchone()
    if row is None:
        return None
    keys = (
        "id",
        "path",
        "filename",
        "media_type",
        "width",
        "height",
        "duration_seconds",
        "video_codec",
        "video_fps",
        "video_has_audio",
        "video_probe_state",
        "video_probe_error",
    )
    return dict(zip(keys, tuple(row)))
