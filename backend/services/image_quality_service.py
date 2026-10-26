"""Picture quality hints for the Check step: scored in the background, cached.

``services.image_quality_scores`` measures one picture. This module decides
which pictures still need it, scores them as one bulk job so the UI never
waits on a request, and remembers the numbers so a second check of the same
files costs nothing.

The cache is one small SQLite file in the cache folder (derived data: delete it
and the numbers come back). A row belongs to a file as it is on disk: the path,
its size and its modification time, and the scoring version. Change any of
them and the picture is scored again.

Nothing here ever changes, moves or deletes a picture.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import config
import database as db
from services.bulk_job_service import BulkJobHandle
from services.image_quality_scores import (
    BLUR_REVIEW_BELOW,
    FLAT_REVIEW_ABOVE,
    SCORES_VERSION,
    QualityScores,
    quality_flags,
    score_image,
)

logger = logging.getLogger(__name__)

CACHE_FILENAME = "image-quality.sqlite3"
_LOOKUP_CHUNK = 400
_WRITE_CHUNK = 40
# Scoring is decode-bound and Pillow releases the GIL while decoding; a few
# threads keep the PC responsive while still using more than one core.
MAX_SCORE_THREADS = 4


@dataclass(frozen=True)
class QualityTarget:
    """One picture to look at: a Library image (id > 0) or a folder file (id 0)."""

    image_id: int
    path: str
    size: int
    mtime_ns: int


@dataclass(frozen=True)
class QualityTally:
    """Where a set of pictures stands: scored, still to score, unreadable, gone."""

    total: int
    scored: Dict[QualityTarget, QualityScores]
    pending: List[QualityTarget]
    unreadable: int
    missing: int


class QualityCache:
    """The scores of files already looked at (one SQLite file, thread-safe)."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.path), timeout=30)
        # Every time: the file may have been deleted since the last call (it is only a cache).
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS image_quality (
                path TEXT PRIMARY KEY,
                size INTEGER NOT NULL,
                mtime_ns INTEGER NOT NULL,
                version INTEGER NOT NULL,
                readable INTEGER NOT NULL,
                blur REAL, edge REAL, flat REAL
            )
            """
        )
        conn.commit()
        return conn

    def get_many(
        self, targets: Sequence[QualityTarget]
    ) -> Dict[str, Optional[QualityScores]]:
        """``{path: scores}`` for the targets whose cached row still matches the file.

        A picture that could not be read is cached too, as ``None``: it is not
        read again until the file changes.
        """
        found: Dict[str, Optional[QualityScores]] = {}
        wanted = {t.path: t for t in targets}
        paths = list(wanted)
        with self._lock:
            conn = self._connect()
            try:
                for start in range(0, len(paths), _LOOKUP_CHUNK):
                    chunk = paths[start : start + _LOOKUP_CHUNK]
                    marks = ",".join("?" * len(chunk))
                    rows = conn.execute(
                        "SELECT path, size, mtime_ns, version, readable, blur, edge, flat "
                        f"FROM image_quality WHERE path IN ({marks})",
                        chunk,
                    ).fetchall()
                    for (
                        path,
                        size,
                        mtime_ns,
                        version,
                        readable,
                        blur,
                        edge,
                        flat,
                    ) in rows:
                        target = wanted[path]
                        if (
                            version != SCORES_VERSION
                            or size != target.size
                            or mtime_ns != target.mtime_ns
                        ):
                            continue
                        found[path] = (
                            QualityScores(blur, edge, flat) if readable else None
                        )
            finally:
                conn.close()
        return found

    def put_many(
        self, rows: Iterable[Tuple[QualityTarget, Optional[QualityScores]]]
    ) -> None:
        records = [
            (
                t.path,
                t.size,
                t.mtime_ns,
                SCORES_VERSION,
                int(s is not None),
                s.blur if s else None,
                s.edge if s else None,
                s.flat if s else None,
            )
            for t, s in rows
        ]
        if not records:
            return
        with self._lock:
            conn = self._connect()
            try:
                conn.executemany(
                    "INSERT OR REPLACE INTO image_quality "
                    "(path, size, mtime_ns, version, readable, blur, edge, flat) "
                    "VALUES (?,?,?,?,?,?,?,?)",
                    records,
                )
                conn.commit()
            finally:
                conn.close()


_cache: Optional[QualityCache] = None


def get_quality_cache() -> QualityCache:
    """The cache file in the current cache folder (follows a changed folder)."""
    global _cache
    path = Path(config.DEFAULT_CACHE_DIR) / CACHE_FILENAME
    if _cache is None or _cache.path != path:
        _cache = QualityCache(path)
    return _cache


def resolve_targets(
    image_ids: Iterable[int] = (), image_paths: Iterable[str] = ()
) -> Tuple[List[QualityTarget], int]:
    """The pictures to look at (Library ids, then folder paths) and how many files are gone."""
    wanted: List[Tuple[int, str]] = []
    seen_ids: set[int] = set()
    clean_ids: List[int] = []
    for raw in image_ids or ():
        try:
            image_id = int(raw)
        except (TypeError, ValueError):
            continue
        if image_id > 0 and image_id not in seen_ids:
            seen_ids.add(image_id)
            clean_ids.append(image_id)
    gone = 0
    for start in range(0, len(clean_ids), 500):
        chunk = clean_ids[start : start + 500]
        records = db.get_images_by_ids(chunk) or {}
        for image_id in chunk:
            path = str((records.get(image_id) or {}).get("path") or "")
            if path:
                wanted.append((image_id, path))
            else:
                gone += 1
    seen_paths: set[str] = set()
    for raw_path in image_paths or ():
        path = str(raw_path or "")
        if path and path not in seen_paths:
            seen_paths.add(path)
            wanted.append((0, path))

    targets: List[QualityTarget] = []
    for image_id, path in wanted:
        try:
            stat = os.stat(path)
        except OSError:
            gone += 1
            continue
        targets.append(
            QualityTarget(image_id, path, int(stat.st_size), int(stat.st_mtime_ns))
        )
    return targets, gone


def tally(
    targets: Sequence[QualityTarget],
    cache: Optional[QualityCache] = None,
    *,
    gone: int = 0,
) -> QualityTally:
    """Which of the targets are scored already, which are unreadable, which still wait."""
    cached = (cache or get_quality_cache()).get_many(targets)
    scored: Dict[QualityTarget, QualityScores] = {}
    pending: List[QualityTarget] = []
    unreadable = 0
    for target in targets:
        if target.path not in cached:
            pending.append(target)
            continue
        scores = cached[target.path]
        if scores is None:
            unreadable += 1
        else:
            scored[target] = scores
    return QualityTally(len(targets) + gone, scored, pending, unreadable, gone)


def run_scoring_job(
    handle: BulkJobHandle,
    pending: Sequence[QualityTarget],
    cache: Optional[QualityCache] = None,
) -> None:
    """Score ``pending`` pictures, saving as it goes; stops early when cancelled."""
    cache = cache or get_quality_cache()
    total = len(pending)
    handle.set_progress(total=total, processed=0, message="Scoring picture quality")
    threads = max(1, min(MAX_SCORE_THREADS, (os.cpu_count() or 2) // 2))
    done = 0
    unreadable = 0
    with ThreadPoolExecutor(max_workers=threads, thread_name_prefix="quality") as pool:
        for start in range(0, total, _WRITE_CHUNK):
            if handle.cancelled:
                break
            chunk = list(pending[start : start + _WRITE_CHUNK])
            results = list(pool.map(lambda t: score_image(t.path), chunk))
            cache.put_many(zip(chunk, results))
            unreadable += sum(1 for r in results if r is None)
            done += len(chunk)
            handle.set_progress(
                processed=done, message=f"Scored {done} of {total} pictures"
            )
    handle.merge_result({"scored": done - unreadable, "unreadable": unreadable})


def flagged_items(
    scored: Dict[QualityTarget, QualityScores],
    *,
    blur_below: float = BLUR_REVIEW_BELOW,
    flat_above: float = FLAT_REVIEW_ABOVE,
) -> List[Dict[str, Any]]:
    """The pictures worth a look, with their numbers; review only."""
    items: List[Dict[str, Any]] = []
    for target, scores in scored.items():
        flags = quality_flags(scores, blur_below=blur_below, flat_above=flat_above)
        if flags:
            items.append(
                {
                    "image_id": target.image_id,
                    "abs_path": target.path,
                    "blur": scores.blur,
                    "edge": scores.edge,
                    "flat": scores.flat,
                    "flags": flags,
                }
            )
    items.sort(key=lambda item: (item["image_id"], item["abs_path"]))
    return items
