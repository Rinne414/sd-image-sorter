"""Dataset Audit service — surfaces existing aesthetic / similarity /
tagging checks as a single LoRA-trainer-readiness report.

Rationale
---------
The audit step tells the user before they hit Train whether their dataset
has obvious problems (low-quality images, duplicates, images with no
captions, dimensions below the trainer's floor). This project already has
all the underlying detectors:

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

PHASH_NEAR_DUPLICATE_LIMIT = 5_000
AUDIT_RESPONSE_ITEM_LIMIT = 5_000
_PHASH_DCT_BASIS = None


def _fallback_phash_hex(image_path: str) -> Optional[str]:
    """Compute a 64-bit pHash without the optional ``imagehash`` package.

    Core installs do not always include ``imagehash``. The Dataset Maker audit
    should still be able to catch obvious duplicates, so this mirrors the
    standard pHash shape with a small numpy DCT implementation.
    """
    global _PHASH_DCT_BASIS
    try:
        import numpy as np
    except Exception as exc:  # noqa: BLE001
        logger.debug("audit: numpy phash fallback unavailable: %s", exc)
        return None

    try:
        with Image.open(image_path) as img:
            resample = getattr(Image, "Resampling", Image).LANCZOS
            gray = img.convert("L").resize((32, 32), resample)
            pixels = np.asarray(gray, dtype=np.float32)
    except (UnidentifiedImageError, OSError, ValueError):
        return None
    except Exception as exc:  # noqa: BLE001
        logger.debug("audit: fallback phash image read failed for %s: %s", image_path, exc)
        return None

    try:
        if _PHASH_DCT_BASIS is None:
            n = 32
            coords = np.arange(n, dtype=np.float32)
            freqs = np.arange(n, dtype=np.float32)
            _PHASH_DCT_BASIS = np.cos(((2 * coords[:, None] + 1) * freqs[None, :] * np.pi) / (2 * n))
        basis = _PHASH_DCT_BASIS
        dct = basis.T @ pixels @ basis
        low = dct[:8, :8].flatten()
        # Exclude the DC coefficient from the threshold, but keep it in the
        # final 64 bits for a stable 16-char hash.
        median = float(np.median(low[1:])) if low.size > 1 else float(low[0])
        value = 0
        for bit in (low > median):
            value = (value << 1) | int(bool(bit))
        return f"{value:016x}"
    except Exception as exc:  # noqa: BLE001
        logger.debug("audit: fallback phash failed for %s: %s", image_path, exc)
        return None


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
    """Compute a perceptual-hash hex digest.

    Prefer the optional ``imagehash`` package when installed, then fall back to
    a local numpy implementation so near-duplicate audit still works in the
    lightweight runtime.
    """
    try:
        import imagehash  # type: ignore[import-untyped]
        with Image.open(image_path) as img:
            return str(imagehash.phash(img.convert("RGB")))
    except ModuleNotFoundError:
        return _fallback_phash_hex(image_path)
    except (UnidentifiedImageError, OSError, ValueError):
        return None
    except Exception as exc:  # noqa: BLE001
        logger.debug("audit: imagehash phash skipped for %s: %s", image_path, exc)
        return _fallback_phash_hex(image_path)


def _phash_backend_error() -> str:
    try:
        import imagehash  # noqa: F401  # type: ignore[import-untyped]
        return ""
    except Exception as exc:  # noqa: BLE001
        try:
            import numpy  # noqa: F401
            return ""
        except Exception as fallback_exc:  # noqa: BLE001
            return (
                f"imagehash unavailable ({exc}); numpy fallback unavailable ({fallback_exc})"
            )


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
    if len(rows) > PHASH_NEAR_DUPLICATE_LIMIT:
        # The near-duplicate algorithm below is O(N^2). For 100k-image
        # datasets, report exact hash collisions only so audit cannot lock up
        # the process. Smaller LoRA-sized sets still get the original behavior.
        buckets: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
        for row in rows:
            hash_value = row.get("phash_hex")
            if hash_value:
                buckets[str(hash_value)].append(row)
        return [
            {
                "phash_hex": hash_value,
                "image_ids": [int(row.get("image_id") or 0) for row in bucket],
                "abs_paths": [str(row.get("abs_path") or "") for row in bucket],
            }
            for hash_value, bucket in buckets.items()
            if len(bucket) > 1
        ]
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
    flags: List[str] = []
    try:
        with Image.open(p) as img:
            width, height = img.size
    except Exception:  # noqa: BLE001
        flags.append("missing")
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
        "flags": flags,
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
    enable_untagged: bool = True,
    item_limit: int = AUDIT_RESPONSE_ITEM_LIMIT,
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
    * ``enable_aesthetic`` / ``enable_phash`` / ``enable_untagged`` -
                             hard-off switches the frontend can flip when
                             a user wants a focused pass without paying the
                             AI inference cost or seeing checks they
                             intentionally disabled.

    Returns the report dict shape documented in the module docstring.
    """
    response_limit = max(0, int(item_limit or 0))
    returned_items: List[Dict[str, Any]] = []
    total_rows = 0
    low_quality_count = 0
    untagged_count = 0
    small_count = 0
    missing_count = 0
    aesthetic_scores: List[float] = []
    phash_checked = bool(enable_phash and phash_max is not None)
    phash_backend_error = _phash_backend_error() if phash_checked else ""
    phash_attempted_count = 0
    phash_success_count = 0
    phash_failed_count = 0
    phash_unavailable_count = 0

    duplicate_rows: List[Dict[str, Any]] = []
    duplicate_exact_mode = False
    seen_hash_first: Dict[str, Dict[str, Any]] = {}
    duplicate_buckets: Dict[str, List[Dict[str, Any]]] = {}

    def _track_exact_duplicate(row: Dict[str, Any]) -> None:
        hash_value = str(row.get("phash_hex") or "")
        if not hash_value:
            return
        if hash_value in duplicate_buckets:
            duplicate_buckets[hash_value].append(row)
            return
        first = seen_hash_first.pop(hash_value, None)
        if first is not None:
            duplicate_buckets[hash_value] = [first, row]
            return
        seen_hash_first[hash_value] = row

    def _track_duplicate(row: Dict[str, Any]) -> None:
        nonlocal duplicate_exact_mode
        if not (enable_phash and phash_max is not None) or not row.get("phash_hex"):
            return
        if duplicate_exact_mode:
            _track_exact_duplicate(row)
            return
        duplicate_rows.append(row)
        if len(duplicate_rows) <= PHASH_NEAR_DUPLICATE_LIMIT:
            return
        duplicate_exact_mode = True
        for prior in duplicate_rows:
            _track_exact_duplicate(prior)
        duplicate_rows.clear()

    def _process_row(row: Dict[str, Any]) -> None:
        nonlocal total_rows, low_quality_count, untagged_count, small_count, missing_count
        nonlocal phash_attempted_count, phash_success_count, phash_failed_count, phash_unavailable_count
        total_rows += 1
        path = row.get("abs_path") or ""
        flags = set(row.get("flags") or [])
        if path and not Path(str(path)).is_file():
            flags.add("missing")
        if path and "missing" not in flags:
            # Backfill width/height for gallery items that the DB row
            # didn't populate (they should but defensive).
            if row.get("width") is None or row.get("height") is None:
                try:
                    with Image.open(path) as img:
                        row["width"], row["height"] = img.size
                except Exception:  # noqa: BLE001
                    flags.add("missing")

            if "missing" not in flags and enable_aesthetic and aesthetic_max is not None:
                row["aesthetic_score"] = _safe_aesthetic_score(path)
            if "missing" not in flags and enable_phash and phash_max is not None:
                phash_attempted_count += 1
                if phash_backend_error:
                    phash_unavailable_count += 1
                else:
                    row["phash_hex"] = _safe_phash_hex(path)
                    if row.get("phash_hex"):
                        phash_success_count += 1
                    else:
                        phash_failed_count += 1

        if "missing" in flags:
            missing_count += 1
            row["flags"] = sorted(flags)
        else:
            # Low-quality: aesthetic_max set + score available + score < max
            if aesthetic_max is not None and row.get("aesthetic_score") is not None:
                score = float(row["aesthetic_score"])
                aesthetic_scores.append(score)
                if score < float(aesthetic_max):
                    flags.add("low_quality")
                    low_quality_count += 1

            # Untagged: tag_count == 0 (cheap and useful, but user-toggleable)
            if enable_untagged and int(row.get("tag_count") or 0) == 0:
                flags.add("untagged")
                untagged_count += 1

            # Small dimension
            if dim_min is not None and row.get("width") and row.get("height"):
                if min(int(row["width"]), int(row["height"])) < int(dim_min):
                    flags.add("small")
                    small_count += 1

            row["flags"] = sorted(flags)
            _track_duplicate(row)

        if response_limit and len(returned_items) < response_limit:
            returned_items.append(row)

    # Gallery-source rows: pull from DB in chunks.
    image_ids_clean: List[int] = []
    seen_ids: set[int] = set()
    for raw_id in image_ids or []:
        try:
            image_id = int(raw_id)
        except (TypeError, ValueError):
            continue
        if image_id > 0 and image_id not in seen_ids:
            seen_ids.add(image_id)
            image_ids_clean.append(image_id)

    if image_ids_clean:
        try:
            import database as db
            for start in range(0, len(image_ids_clean), 500):
                chunk = image_ids_clean[start:start + 500]
                images_map = db.get_images_by_ids(chunk) or {}
                tags_map = db.get_image_tags_map(chunk) or {}
                for image_id in chunk:
                    record = images_map.get(image_id)
                    if not record:
                        _process_row({
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
                    _process_row(_row_for_image_id(image_id, record, tags_map))
        except Exception as exc:
            logger.error("audit: DB lookup failed: %s", exc)
            for image_id in image_ids_clean:
                _process_row({
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

    # Path-source rows: build virtual records one-by-one.
    path_extra: Dict[str, int] = {
        str(k): int(v or 0) for k, v in (extra_tag_counts or {}).items()
    }
    for p in (image_paths or []):
        if not p:
            continue
        path_key = str(p)
        row = _row_for_path(path_key)
        # Inject any localStorage-derived tag count the frontend supplied
        # (a non-empty caption is treated as "tag_count >= 1" for the
        # untagged check).
        if path_extra.get(path_key):
            row["tag_count"] = int(path_extra[path_key])
        _process_row(row)

    duplicate_groups: List[Dict[str, Any]] = []
    if enable_phash and phash_max is not None:
        if duplicate_exact_mode:
            duplicate_groups = [
                {
                    "phash_hex": hash_value,
                    "image_ids": [int(row.get("image_id") or 0) for row in bucket],
                    "abs_paths": [str(row.get("abs_path") or "") for row in bucket],
                }
                for hash_value, bucket in duplicate_buckets.items()
                if len(bucket) > 1
            ]
        else:
            duplicate_groups = _build_duplicate_groups(duplicate_rows, int(phash_max))

    avg_aesthetic = (sum(aesthetic_scores) / len(aesthetic_scores)) if aesthetic_scores else None
    return {
        "summary": {
            "total": total_rows,
            "low_quality_count": low_quality_count,
            "duplicate_pairs": len(duplicate_groups),
            "untagged_count": untagged_count,
            "small_count": small_count,
            "missing_count": missing_count,
            "avg_aesthetic": (round(avg_aesthetic, 3) if avg_aesthetic is not None else None),
            "near_duplicate_check_limited": bool(
                enable_phash and phash_max is not None and total_rows > PHASH_NEAR_DUPLICATE_LIMIT
            ),
            "near_duplicate_checked": phash_checked,
            "near_duplicate_attempted": phash_attempted_count,
            "near_duplicate_hashes": phash_success_count,
            "near_duplicate_failed": phash_failed_count,
            "near_duplicate_unavailable_count": phash_unavailable_count,
            "near_duplicate_error": phash_backend_error,
        },
        "items": returned_items,
        "items_truncated": len(returned_items) < total_rows,
        "items_returned": len(returned_items),
        "duplicate_groups": duplicate_groups,
    }
