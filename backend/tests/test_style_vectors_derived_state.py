"""Style vectors count as derived state (S1, review HIGH-3).

A rescan that finds new pixels at a known path clears cached machine output
(tags, captions, artist predictions...). That decision is taken from an
``existing_row`` read by three SELECTs and judged by two predicates; an image
whose only cached output is a style vector must be seen by all of them, or the
DELETE added to ``_clear_image_derived_state`` never runs.
"""

from __future__ import annotations

import pytest

import db_helpers
import image_manager_gates


def _insert_vector(conn, image_id: int) -> None:
    conn.execute(
        """
        INSERT INTO image_style_vectors
            (image_id, space, model_version, content_fingerprint, dim, dtype, vector)
        VALUES (?, 'kaloscope', 'model:v1', 'fp-old', 4, 'float16', X'00000000')
        """,
        (image_id,),
    )


def _vector_count(test_db, image_id: int) -> int:
    with test_db.get_db() as conn:
        return conn.execute(
            "SELECT COUNT(*) FROM image_style_vectors WHERE image_id = ?", (image_id,)
        ).fetchone()[0]


def _vector_only_image(test_db, tmp_path, name: str = "vec.png") -> int:
    """An image whose only cached machine output is a style vector."""
    image_id = test_db.add_image(
        path=str(tmp_path / name),
        filename=name,
        source_mtime_ns=100,
        source_size=200,
        content_fingerprint="fp-old",
    )
    with test_db.get_db() as conn:
        row = conn.execute(
            "SELECT tagged_at, ai_caption, aesthetic_score, embedding FROM images WHERE id = ?",
            (image_id,),
        ).fetchone()
        assert tuple(row) == (None, None, None, None)
        _insert_vector(conn, image_id)
    return image_id


@pytest.mark.parametrize(
    "predicate",
    [db_helpers._has_derived_state, image_manager_gates._has_cached_derived_state],
    ids=["db_helpers", "image_manager_gates"],
)
def test_predicates_count_style_vectors(predicate):
    bare = {
        "tagged_at": None,
        "ai_caption": None,
        "aesthetic_score": None,
        "has_embedding": 0,
        "has_artist_predictions": 0,
    }
    assert predicate({**bare, "has_style_vectors": 0}) is False
    assert predicate({**bare, "has_style_vectors": 1}) is True


def test_scan_state_rows_expose_style_vectors(test_db, tmp_path):
    image_id = _vector_only_image(test_db, tmp_path)
    rows = test_db.get_image_scan_state_by_paths([str(tmp_path / "vec.png")])
    row = next(row for row in rows.values()) if isinstance(rows, dict) else rows[0]
    assert int(row["id"]) == image_id
    assert bool(row["has_style_vectors"]) is True


@pytest.mark.parametrize(
    "new_fingerprint", ["fp2", None], ids=["new-digest", "unknown-digest"]
)
def test_update_image_metadata_clears_vector_only_image_on_pixel_change(
    test_db, tmp_path, new_fingerprint
):
    image_id = _vector_only_image(test_db, tmp_path)

    test_db.update_image_metadata(
        image_id=image_id,
        generator="comfyui",
        prompt="pixels changed",
        negative_prompt=None,
        metadata_json="{}",
        width=768,
        height=768,
        file_size=300,
        checkpoint=None,
        loras=[],
        source_mtime_ns=101,
        source_size=300,
        metadata_status="complete",
        content_fingerprint=new_fingerprint,
        preserve_derived_state=True,
    )

    assert _vector_count(test_db, image_id) == 0


@pytest.mark.parametrize(
    "new_fingerprint", ["fp2", None], ids=["new-digest", "unknown-digest"]
)
def test_rescan_upsert_clears_vector_only_image_on_pixel_change(
    test_db, tmp_path, new_fingerprint
):
    image_id = _vector_only_image(test_db, tmp_path)

    same_id = test_db.add_image(
        path=str(tmp_path / "vec.png"),
        filename="vec.png",
        source_mtime_ns=101,
        source_size=300,
        content_fingerprint=new_fingerprint,
    )

    assert same_id == image_id
    assert _vector_count(test_db, image_id) == 0


def test_rescan_with_same_pixels_keeps_vector_only_image(test_db, tmp_path):
    image_id = _vector_only_image(test_db, tmp_path)

    test_db.add_image(
        path=str(tmp_path / "vec.png"),
        filename="vec.png",
        source_mtime_ns=101,
        source_size=200,
        content_fingerprint="fp-old",
    )

    assert _vector_count(test_db, image_id) == 1
