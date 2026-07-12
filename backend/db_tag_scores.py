"""tag_scores persistence — every tagger score >= floor, per (image, model, tag).

BE-1 (tagger/editor master plan, Phase 2 foundation). Persisting the raw
score distribution at tagging time turns the threshold into a virtual,
zero-inference knob:

* re-threshold = read scores back at a new cutoff and rewrite tag rows
  through the normal add_tags path (no ONNX run);
* coverage gaps = "images whose score for this tag sits just under the
  threshold" — the Separation Console's find-missing button (N2);
* per-model audit = "which model said what, at what confidence".

Size control: rows below config.TAG_SCORES_FLOOR are dropped at write time
(defense in depth — producers also gate on config.TAG_SCORES_ENABLED), and
stats/purge maintenance lives here. 100k images x 1 model lands around
400-600 MB at floor 0.10, which is why the floor and the enable switch are
user-tunable env settings.

Imports only config / db_core / stdlib to stay cycle-free with the
``database`` facade (same rule as db_tags).
"""
import logging
from typing import Any, Dict, List, Optional, Tuple

import config
from db_core import get_db

logger = logging.getLogger(__name__)

_BATCH_SIZE = 500

_SCORE_INSERT_SQL = (
    "INSERT OR REPLACE INTO tag_scores (image_id, model, tag, score, category) "
    "VALUES (?, ?, ?, ?, ?)"
)


def _normalize_score_sets(score_sets: Any) -> List[Tuple[str, List[Dict[str, Any]]]]:
    """Accept one {"model", "scores"} dict or a list of them (multi-model
    runs like Smart Tag persist one set per model)."""
    if isinstance(score_sets, dict):
        score_sets = [score_sets]
    normalized: List[Tuple[str, List[Dict[str, Any]]]] = []
    for entry in score_sets or []:
        if not isinstance(entry, dict):
            continue
        model = str(entry.get("model") or "").strip()
        scores = entry.get("scores")
        if not model or not isinstance(scores, list):
            continue
        normalized.append((model, scores))
    return normalized


def replace_scores_in_cursor(cursor, image_id: int, score_sets: Any) -> int:
    """Replace the stored score set(s) for one image inside the caller's
    transaction (add_tags_batch calls this so tag rows and scores commit
    atomically). Returns the number of rows written.

    Each set fully replaces that (image, model) slice — a re-tag with the
    same model never leaves stale scores behind. Rows under the configured
    floor are dropped here so no caller can accidentally blow up the table.
    """
    floor = float(config.TAG_SCORES_FLOOR)
    written = 0
    for model, scores in _normalize_score_sets(score_sets):
        cursor.execute(
            "DELETE FROM tag_scores WHERE image_id = ? AND model = ?",
            (image_id, model),
        )
        rows = []
        for item in scores:
            if not isinstance(item, dict):
                continue
            tag = str(item.get("tag") or "").strip()
            if not tag:
                continue
            try:
                score = float(item.get("score", item.get("confidence", 0.0)))
            except (TypeError, ValueError):
                continue
            if score < floor:
                continue
            rows.append(
                (image_id, model, tag, min(score, 1.0), item.get("category") or None)
            )
        if rows:
            cursor.executemany(_SCORE_INSERT_SQL, rows)
            written += len(rows)
    return written


def get_scores_for_images(
    image_ids: List[int], model: str
) -> Dict[int, List[Dict[str, Any]]]:
    """Stored score rows for one model across a set of images (re-threshold
    read path — served by the WITHOUT ROWID primary key)."""
    ids = [int(i) for i in (image_ids or []) if int(i) > 0]
    if not ids or not model:
        return {}
    result: Dict[int, List[Dict[str, Any]]] = {}
    with get_db() as conn:
        cursor = conn.cursor()
        for start in range(0, len(ids), _BATCH_SIZE):
            batch = ids[start:start + _BATCH_SIZE]
            placeholders = ",".join("?" * len(batch))
            cursor.execute(
                f"""
                SELECT image_id, tag, score, category
                FROM tag_scores
                WHERE model = ? AND image_id IN ({placeholders})
                ORDER BY image_id ASC, score DESC
                """,
                (model, *batch),
            )
            for row in cursor.fetchall():
                result.setdefault(int(row[0]), []).append(
                    {"tag": row[1], "score": row[2], "category": row[3]}
                )
    return result


def list_score_models(image_ids: Optional[List[int]] = None) -> List[Dict[str, Any]]:
    """Models that have stored scores (optionally within an image scope),
    with how many of those images each covers — the re-threshold UI uses
    this to offer model choices and show coverage."""
    with get_db() as conn:
        cursor = conn.cursor()
        if not image_ids:
            cursor.execute(
                """
                SELECT model, COUNT(DISTINCT image_id)
                FROM tag_scores GROUP BY model ORDER BY model ASC
                """
            )
            return [
                {"model": row[0], "images": int(row[1] or 0)}
                for row in cursor.fetchall()
            ]

        ids = [int(i) for i in image_ids if int(i) > 0]
        counts: Dict[str, int] = {}
        for start in range(0, len(ids), _BATCH_SIZE):
            batch = ids[start:start + _BATCH_SIZE]
            placeholders = ",".join("?" * len(batch))
            cursor.execute(
                f"""
                SELECT model, COUNT(DISTINCT image_id)
                FROM tag_scores WHERE image_id IN ({placeholders})
                GROUP BY model
                """,
                batch,
            )
            for row in cursor.fetchall():
                counts[row[0]] = counts.get(row[0], 0) + int(row[1] or 0)
        return [
            {"model": model, "images": counts[model]} for model in sorted(counts)
        ]


def find_coverage_gaps(
    tag: str,
    *,
    band_low: float,
    band_high: float,
    image_ids: Optional[List[int]] = None,
    model: Optional[str] = None,
    limit: int = 200,
) -> List[Dict[str, Any]]:
    """Images that ALMOST have ``tag``: a stored score inside
    [band_low, band_high) but no current tag row (N2 coverage completion).

    When ``model`` is None the best score across models wins per image.
    Unreadable images are skipped (nothing actionable to show).
    """
    tag_value = str(tag or "").strip()
    if not tag_value or band_high <= band_low:
        return []

    ids = [int(i) for i in (image_ids or []) if int(i) > 0]
    best: Dict[int, Dict[str, Any]] = {}

    def _consume(cursor, id_batch: Optional[List[int]]) -> None:
        clauses = ""
        params: List[Any] = [tag_value, float(band_low), float(band_high)]
        if model:
            clauses += " AND ts.model = ?"
            params.append(model)
        if id_batch is not None:
            placeholders = ",".join("?" * len(id_batch))
            clauses += f" AND ts.image_id IN ({placeholders})"
            params.extend(id_batch)
        params.append(tag_value)
        cursor.execute(
            f"""
            SELECT ts.image_id, ts.model, ts.score, i.filename, i.path
            FROM tag_scores ts
            JOIN images i ON i.id = ts.image_id
            WHERE ts.tag = ? AND ts.score >= ? AND ts.score < ?{clauses}
              AND COALESCE(i.is_readable, 1) = 1
              AND NOT EXISTS (
                  SELECT 1 FROM tags t
                  WHERE t.image_id = ts.image_id AND LOWER(t.tag) = LOWER(?)
              )
            """,
            params,
        )
        for row in cursor.fetchall():
            image_id = int(row[0])
            candidate = {
                "image_id": image_id,
                "model": row[1],
                "score": float(row[2]),
                "filename": row[3],
                "path": row[4],
            }
            current = best.get(image_id)
            if current is None or candidate["score"] > current["score"]:
                best[image_id] = candidate

    with get_db() as conn:
        cursor = conn.cursor()
        if ids:
            for start in range(0, len(ids), _BATCH_SIZE):
                _consume(cursor, ids[start:start + _BATCH_SIZE])
        else:
            _consume(cursor, None)

    ranked = sorted(best.values(), key=lambda item: -item["score"])
    return ranked[: max(0, int(limit))] if limit else ranked


def get_tag_model_audit(
    tag: str, image_ids: Optional[List[int]] = None
) -> List[Dict[str, Any]]:
    """Per-model score distribution for ONE tag (BE-1-UI audit panel:
    "which model said this, at what confidence"). Scope by image ids when
    given; batched to stay under the SQLite bind-variable limit. AVG is
    merged across batches via SUM/COUNT."""
    tag_value = str(tag or "").strip()
    if not tag_value:
        return []
    ids = [int(i) for i in (image_ids or []) if int(i) > 0]
    merged: Dict[str, Dict[str, Any]] = {}

    def _consume(cursor, id_batch: Optional[List[int]]) -> None:
        clause = ""
        params: List[Any] = [tag_value]
        if id_batch is not None:
            placeholders = ",".join("?" * len(id_batch))
            clause = f" AND image_id IN ({placeholders})"
            params.extend(id_batch)
        cursor.execute(
            f"""
            SELECT model, COUNT(*), SUM(score), MAX(score), MIN(score)
            FROM tag_scores
            WHERE tag = ?{clause}
            GROUP BY model
            """,
            params,
        )
        for row in cursor.fetchall():
            slot = merged.setdefault(
                row[0], {"images": 0, "score_sum": 0.0, "max": 0.0, "min": 1.0}
            )
            slot["images"] += int(row[1] or 0)
            slot["score_sum"] += float(row[2] or 0.0)
            slot["max"] = max(slot["max"], float(row[3] or 0.0))
            slot["min"] = min(slot["min"], float(row[4] or 1.0))

    with get_db() as conn:
        cursor = conn.cursor()
        if ids:
            for start in range(0, len(ids), _BATCH_SIZE):
                _consume(cursor, ids[start:start + _BATCH_SIZE])
        else:
            _consume(cursor, None)

    return [
        {
            "model": model,
            "images": slot["images"],
            "avg_score": round(slot["score_sum"] / slot["images"], 4) if slot["images"] else 0.0,
            "max_score": round(slot["max"], 4),
            "min_score": round(slot["min"], 4),
        }
        for model, slot in sorted(merged.items())
    ]


def get_tag_score_stats() -> Dict[str, Any]:
    """Storage report for the maintenance UI (owner decision #1: default-on
    needs visible cost + a purge escape hatch)."""
    with get_db() as conn:
        cursor = conn.cursor()
        total = cursor.execute("SELECT COUNT(*) FROM tag_scores").fetchone()[0] or 0
        images = (
            cursor.execute(
                "SELECT COUNT(DISTINCT image_id) FROM tag_scores"
            ).fetchone()[0]
            or 0
        )
        models = [
            {
                "model": row[0],
                "rows": int(row[1] or 0),
                "images": int(row[2] or 0),
            }
            for row in cursor.execute(
                """
                SELECT model, COUNT(*), COUNT(DISTINCT image_id)
                FROM tag_scores GROUP BY model ORDER BY COUNT(*) DESC
                """
            ).fetchall()
        ]
    return {
        "enabled": bool(config.TAG_SCORES_ENABLED),
        "floor": float(config.TAG_SCORES_FLOOR),
        "total_rows": int(total),
        "images_with_scores": int(images),
        "models": models,
        # ~60 bytes/row on a WITHOUT ROWID probe — a UI hint, not accounting.
        "estimated_bytes": int(total) * 60,
    }


def purge_tag_scores(model: Optional[str] = None) -> int:
    """Delete stored scores (all models, or one). Returns rows removed."""
    with get_db() as conn:
        cursor = conn.cursor()
        if model:
            cursor.execute("DELETE FROM tag_scores WHERE model = ?", (model,))
        else:
            cursor.execute("DELETE FROM tag_scores")
        return cursor.rowcount or 0
