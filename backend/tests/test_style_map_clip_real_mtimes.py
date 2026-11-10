"""The style map's CLIP space works on a library whose files carry real timestamps.

The map's cache key added up every picture's ``source_mtime_ns``. A real file
time is about 1.7e18 ns, so six pictures already passed SQLite's 64-bit
integers and every CLIP map request answered "Internal server error" (seen on
a real 147-picture library, 2026-11-10). The earlier tests left the column
empty, which sums to zero.
"""

from __future__ import annotations

import time

from tests.test_style_map_points import (
    _make_images,
    _random_units,
    _service,
    _store_clip,
)


def _stamp_real_file_times(test_db, image_ids, moved_ns: int = 0) -> None:
    now_ns = time.time_ns()
    with test_db.get_db() as conn:
        for offset, image_id in enumerate(image_ids):
            conn.execute(
                "UPDATE images SET source_mtime_ns = ?, source_size = ? WHERE id = ?",
                (
                    now_ns - offset * 1_000_000_000 + moved_ns,
                    2_000_000 + offset,
                    image_id,
                ),
            )


def test_clip_map_of_a_library_with_real_file_times_is_drawn(test_db, tmp_path):
    ids = _make_images(test_db, tmp_path, 40)
    _store_clip(test_db, ids, _random_units(40, seed=5))
    _stamp_real_file_times(test_db, ids)

    result = _service().points("clip")

    assert result["space"] == "clip"
    assert result["missing_vectors"] == 0


def test_a_changed_file_time_still_changes_the_clip_map_key(test_db, tmp_path):
    from db_style_vectors import vector_signature

    ids = _make_images(test_db, tmp_path, 12)
    _store_clip(test_db, ids, _random_units(12, seed=6))
    _stamp_real_file_times(test_db, ids)
    with test_db.get_db() as conn:
        before = vector_signature(conn.cursor(), space="clip", model_version="")

    _stamp_real_file_times(test_db, ids[:1], moved_ns=5_000_000)
    with test_db.get_db() as conn:
        after = vector_signature(conn.cursor(), space="clip", model_version="")

    assert after != before


def test_clip_pictures_sharing_one_large_component_are_all_placed(test_db, tmp_path):
    """Real CLIP ViT-B/32 embeddings all carry one large component (0.42 to
    0.66 of the unit vector, the same dimension in every picture: measured on
    147 pictures). The "one component over 0.5 is a broken picture" rule is
    for the style model; in the CLIP space it left out 105 of the 147."""
    import numpy as np

    ids = _make_images(test_db, tmp_path, 30)
    vectors = _random_units(30, seed=9)
    vectors[:, 7] = np.linspace(0.9, 1.4, 30)  # the shared large component
    vectors = vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
    assert (np.abs(vectors).max(axis=1) > 0.5).sum() > 15
    _store_clip(test_db, ids, vectors)

    result = _service().points("clip")

    assert result["unlocatable"] == []
    assert len(result["points"]) + result["merged_away"] == 30
