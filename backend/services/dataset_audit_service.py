"""Dataset Audit service — surfaces existing aesthetic / similarity /
tagging checks as a single LoRA-trainer-readiness report.

Rationale
---------
LoraHub's Image Studio audit step is one of the strongest "noob save"
features it ships: it tells the user before they hit Train whether
their dataset has obvious problems (low-quality images, duplicates,
images with no captions, dimensions below the trainer's floor). This
project already has all the underlying detectors:

  * ``backend/aesthetic.py``  — CLIP ViT-L + LAION head, ~1-10 score
  * ``backend/similarity.py`` — perceptual hash for near-duplicate
                                detection
  * ``database.get_image_tags_map`` — tag count per image
  * Image dimensions live in the row itself (or read from disk for
    path-source small-gallery items)

This service wraps those into a single ``audit_dataset()`` call so the
Dataset Maker UI can surface the report next to the queue.

Defaults / hard limits
----------------------
The user requested NO hard limits. Every threshold is optional and
defaults to ``None`` meaning "do not flag images for that dimension".
The frontend's UX is "audit is off by default, you turn it on, you
fill the thresholds you care about, you re-run, you remove the items
you want gone". No surprise auto-deletion.

Per-image scoring
-----------------
``audit_dataset`` returns a top-level summary plus a per-image record
the frontend can use to highlight individual queue items::

    {
        "summary": {
            "total": int,
            "low_quality_count": int,
            "duplicate_pairs": int,
            "untagged_count": int,
            "small_count": int,
            "missing_count": int,
            "avg_aesthetic": Optional[float],
        },
        "items": [
            {
                "image_id": int,        # 0 for path-source items
                "abs_path": str,
                "filename": str,
                "width": Optional[int],
                "height": Optional[int],
                "aesthetic_score": Optional[float],
                "tag_count": int,
                "phash_hex": Optional[str],
                "flags": [
                    "low_quality" | "untagged" | "small" | "missing"
                    # duplicates flagged via the duplicate_groups list
                ],
            },
            ...
        ],
        "duplicate_groups": [
            { "phash_hex": str, "image_ids": [int...], "abs_paths": [str...] },
            ...
        ],
    }
"""
from __future__ import annotations

import logging
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from PIL import Image, UnidentifiedImageError


logger = logging.getLogger(__name__)


def _safe_aesthetic_score(image_path: str) -> Optional[float]:
    """Run aesthetic prediction with all the defensive guards the rest
    of the app uses (missing torch, GPU OOM, etc). Returns None on any
    failure so the audit doesn't take down the whole pipeline."""
    try:
        import aesthetic  # local import so missing torch doesn't break audit
        return aesthetic.predict_score(image_path)
    except Exception as exc:  # noqa: BLE001
        logger.debug("audit: aesthetic skipped for %s: %s", image_path, exc)
        return None


def _safe_phash_hex(image_path: str) -> Optional[str]:
    """Compute a perceptual-hash hex digest. Falls back to None if
    the image can't be opened or PIL/imagehash isn't available."""
    try:
        # imagehash is a hard dep used by similarity.py; if it's missing
        # we silently skip duplicate detection rather than crashing.
        import imagehash  # type: ignore[import-untyped]
        with Image.open(image_path) as img:
            return str(imagehash.phash(img.convert("RGB")))
    except (UnidentifiedImageError, OSError, ValueError):
        return None
    except Exception as exc:  # noqa: BLE001
        logger.debug("audit: phash skipped for %s: %s", image_path, exc)
        return None


def _hamming_distance_hex(a: str, b: str) -> int:
    """Hamming distance between two equal-length hex strings.

    imagehash digests are usually 16-char (64-bit phash). Different
    lengths -> we treat as completely different (return a large value).
    """
    if not a or not b or len(a) != len(b):
        return 999
    try:
        ai = int(a, 16)
        bi = int(b, 16)
    except ValueError:
        return 999
    return bin(ai ^ bi).count("1")


def _build_duplicate_groups(
    rows: List[Dict[str, Any]], phash_max: int
) -> List[Dict[str, Any]]:
    """Cluster rows by Hamming-distance proximity into duplicate groups.

    Naive O(N^2). Acceptable up to ~5000 images (the Dataset Maker
    session cap). Higher-volume callers should use a vp-tree or BK-tree
    instead — out of scope for v3.2.2.
    """
    if phash_max < 0:
        return []
    groups: List[Dict[str, Any]] = []
    consumed: set = set()
    for i, row_i in enumerate(rows):
        if i in consumed:
            continue
        hash_i = row_i.get("phash_hex")
        if not hash_i:
            continue
        cluster: List[int] = [i]
        for j in range(i + 1, len(rows)):
            if j in consumed:
                continue
            hash_j = rows[j].get("phash_hex")
            if not hash_j:
                continue
            if _hamming_distance_hex(hash_i, hash_j) <= phash_max:
                cluster.append(j)
        if len(cluster) > 1:
            for idx in cluster:
                consumed.add(idx)
            groups.append({
                "phash_hex": hash_i,
                "image_ids": [int(rows[k].get("image_id") or 0) for k in cluster],
                "abs_paths": [str(rows[k].get("abs_path") or "") for k in cluster],
            })
    return groups


def _row_for_image_id(image_id: int, image_record: Dict[str, Any], tag_map: Dict[int, List[Any]]) -> Dict[str, Any]:
    return {
        "image_id": int(image_id),
        "abs_path": str(image_record.get("path") or ""),
        "filename": str(image_record.get("filename") or ""),
        "width": image_record.get("width"),
        "height": image_record.get("height"),
        "tag_count": len(tag_map.get(image_id, []) or []),
        "aesthetic_score": None,
        "phash_hex": None,
        "flags": [],
    }


def _row_for_path(abs_path: str) -> Dict[str, Any]:
    p = Path(abs_path)
    width: Optional[int] = None
    height: Optional[int] = None
    try:
        with Image.open(p) as img:
            width, height = img.size
    except Exception:  # noqa: BLE001
        pass
    return {
        "image_id": 0,
        "abs_path": str(p),
        "filename": p.name,
        "width": width,
        "height": height,
        # Path-source items have no DB tags; the audit can't see
        # the user's localStorage caption from here, so tag_count
        # tracks the LOCAL_TAG_COUNT_FROM_API flag the frontend
        # injects (see ``audit_dataset`` 'extra_tag_counts').
        "tag_count": 0,
        "aesthetic_score": None,
        "phash_hex": None,
        "flags": [],
    }


def audit_dataset(
    *,
    image_ids: Optional[Iterable[int]] = None,
    image_paths: Optional[Iterable[str]] = None,
    aesthetic_max: Optional[float] = None,
    phash_max: Optional[int] = None,
    dim_min: Optional[int] = None,
    extra_tag_counts: Optional[Dict[str, int]] = None,
    enable_aesthetic: bool = True,
    enable_phash: bool = True,
) -> Dict[str, Any]:
    """Run the audit pipeline over a Dataset Maker session.

    Parameters mirror the JSON request the router expects:

    * ``image_ids``   - main-library row ids (gallery-source items)
    * ``image_paths`` - absolute paths (small-gallery local items)
    * ``aesthetic_max`` - flag images with score < this. ``None`` -> skip
    * ``phash_max``     - flag duplicates whose Hamming distance <= this.
                          ``None`` -> skip duplicate detection entirely
    * ``dim_min``       - flag images whose min(width,height) < this.
                          ``None`` -> skip dimension check
    * ``extra_tag_counts`` - optional ``{abs_path: tag_count}`` injected
                             by the frontend so local items can also
                             be flagged ``untagged`` based on their
                             localStorage caption length
    * ``enable_aesthetic`` / ``enable_phash`` - hard-off switches the
                             frontend can flip when a user just wants a
                             quick "what's missing tags?" pass without
                             paying the AI inference cost.

    Returns the report dict shape documented in the module docstring.
    """
    rows: List[Dict[str, Any]] = []

    # Gallery-source rows: pull from DB.
    image_ids_clean = list({int(i) for i in (image_ids or []) if int(i) > 0})
    if image_ids_clean:
        try:
            import database as db
            images_map = db.get_images_by_ids(image_ids_clean) or {}
            tags_map = db.get_image_tags_map(image_ids_clean) or {}
        except Exception as exc:
            logger.error("audit: DB lookup failed: %s", exc)
            images_map = {}
            tags_map = {}
        for image_id in image_ids_clean:
            record = images_map.get(image_id)
            if not record:
                rows.append({
                    "image_id": image_id,
                    "abs_path": "",
                    "filename": f"image_{image_id}",
                    "width": None,
                    "height": None,
                    "tag_count": 0,
                    "aesthetic_score": None,
                    "phash_hex": None,
                    "flags": ["missing"],
                })
                continue
            rows.append(_row_for_image_id(image_id, record, tags_map))

    # Path-source rows: build virtual records.
    path_extra: Dict[str, int] = {
        str(k): int(v or 0) for k, v in (extra_tag_counts or {}).items()
    }
    for p in (image_paths or []):
        if not p:
            continue
        row = _row_for_path(str(p))
        # Inject any localStorage-derived tag count the frontend supplied
        # (a non-empty caption is treated as "tag_count >= 1" for the
        # untagged check).
        if path_extra.get(str(p)):
            row["tag_count"] = int(path_extra[str(p)])
        rows.append(row)

    # Per-image enrichments
    for row in rows:
        path = row.get("abs_path") or ""
        if not path or "missing" in row["flags"]:
            continue

        # Backfill width/height for gallery items that the DB row
        # didn't populate (they should but defensive).
        if row.get("width") is None or row.get("height") is None:
            try:
                with Image.open(path) as img:
                    row["width"], row["height"] = img.size
            except Exception:  # noqa: BLE001
                pass

        if enable_aesthetic and aesthetic_max is not None:
            row["aesthetic_score"] = _safe_aesthetic_score(path)
        if enable_phash and phash_max is not None:
            row["phash_hex"] = _safe_phash_hex(path)

    # Apply flags using the requested thresholds.
    low_quality_count = 0
    untagged_count = 0
    small_count = 0
    missing_count = 0
    aesthetic_scores: List[float] = []

    for row in rows:
        flags = set(row.get("flags") or [])
        if "missing" in flags:
            missing_count += 1
            row["flags"] = sorted(flags)
            continue

        # Low-quality: aesthetic_max set + score available + score < max
        if aesthetic_max is not None and row.get("aesthetic_score") is not None:
            score = float(row["aesthetic_score"])
            aesthetic_scores.append(score)
            if score < float(aesthetic_max):
                flags.add("low_quality")
                low_quality_count += 1

        # Untagged: tag_count == 0 (always evaluated; cheap and useful)
        if int(row.get("tag_count") or 0) == 0:
            flags.add("untagged")
            untagged_count += 1

        # Small dimension
        if dim_min is not None and row.get("width") and row.get("height"):
            if min(int(row["width"]), int(row["height"])) < int(dim_min):
                flags.add("small")
                small_count += 1

        row["flags"] = sorted(flags)

    # Duplicate groups (only if phash was enabled)
    duplicate_groups: List[Dict[str, Any]] = []
    if enable_phash and phash_max is not None:
        duplicate_groups = _build_duplicate_groups(rows, int(phash_max))

    avg_aesthetic = (sum(aesthetic_scores) / len(aesthetic_scores)) if aesthetic_scores else None

    return {
        "summary": {
            "total": len(rows),
            "low_quality_count": low_quality_count,
            "duplicate_pairs": len(duplicate_groups),
            "untagged_count": untagged_count,
            "small_count": small_count,
            "missing_count": missing_count,
            "avg_aesthetic": (round(avg_aesthetic, 3) if avg_aesthetic is not None else None),
        },
        "items": rows,
        "duplicate_groups": duplicate_groups,
    }
