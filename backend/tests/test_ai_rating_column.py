"""BE-3: first-class AI rating columns (images.ai_rating / ai_rating_confidence).

The tagger's rating verdict used to exist only as a tag row; rating
filter/sort/exclude probed the tags table with EXISTS per image. Migration
026 denormalizes the winning verdict onto images, and
``db_tags._sync_ai_rating`` re-derives it after EVERY tag replace
(add_tags / add_tags_batch — which is also every bulk op and bulk-undo
path, since those route through add_tags). These tests pin:

* sync on write: best rating row (confidence DESC, severity tiebreak) wins;
* clear on rating-row removal and on derived-state clear;
* the query layer reads the COLUMN, not the rows (filter / sort / exclude);
* dual-write compatibility: the rating tag row itself still exists.
"""
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import database as db
import db_images_write


def _rating_cols(image_id):
    conn = sqlite3.connect(db.DATABASE_PATH)
    try:
        return conn.execute(
            "SELECT ai_rating, ai_rating_confidence FROM images WHERE id = ?",
            (image_id,),
        ).fetchone()
    finally:
        conn.close()


def _add_image(path):
    return db.add_image(
        path=path,
        filename=path.rsplit("/", 1)[-1],
        generator="comfyui",
        metadata_json="{}",
    )


class TestSyncOnWrite:
    def test_add_tags_sets_ai_rating_from_best_rating_row(self, test_db):
        image_id = _add_image("/test/rating/a.png")
        db.add_tags(image_id, [
            {"tag": "1girl", "confidence": 0.99},
            {"tag": "sensitive", "confidence": 0.85},
        ])
        rating, conf = _rating_cols(image_id)
        assert rating == "sensitive"
        assert conf == pytest.approx(0.85)
        # Dual-write: the rating tag ROW is still there (export/console read rows).
        tag_names = [t["tag"] for t in db.get_image_tags(image_id)]
        assert "sensitive" in tag_names

    def test_replace_without_rating_row_clears_column(self, test_db):
        image_id = _add_image("/test/rating/b.png")
        db.add_tags(image_id, [{"tag": "explicit", "confidence": 0.9}])
        assert _rating_cols(image_id)[0] == "explicit"
        db.add_tags(image_id, [{"tag": "1girl", "confidence": 0.9}])
        assert _rating_cols(image_id) == (None, None)

    def test_highest_confidence_wins_severity_breaks_ties(self, test_db):
        image_id = _add_image("/test/rating/c.png")
        # Higher confidence wins regardless of severity...
        db.add_tags(image_id, [
            {"tag": "general", "confidence": 0.9},
            {"tag": "explicit", "confidence": 0.2},
        ])
        assert _rating_cols(image_id)[0] == "general"
        # ...and on an exact confidence tie the more severe verdict wins.
        db.add_tags(image_id, [
            {"tag": "questionable", "confidence": 0.5},
            {"tag": "explicit", "confidence": 0.5},
        ])
        assert _rating_cols(image_id)[0] == "explicit"

    def test_pipeline_retag_updates_rating_and_manual_rows_survive(self, test_db):
        image_id = _add_image("/test/rating/d.png")
        db.add_tags(image_id, [{"tag": "my_manual_tag", "confidence": 1.0}],
                    default_source="manual")
        db.add_tags(
            image_id,
            [{"tag": "sensitive", "confidence": 0.7, "category": "rating"}],
            default_source="tagger",
            replace_scope="pipeline",
        )
        assert _rating_cols(image_id)[0] == "sensitive"
        db.add_tags(
            image_id,
            [{"tag": "explicit", "confidence": 0.8, "category": "rating"}],
            default_source="tagger",
            replace_scope="pipeline",
        )
        assert _rating_cols(image_id)[0] == "explicit"
        tag_names = [t["tag"] for t in db.get_image_tags(image_id)]
        assert "my_manual_tag" in tag_names

    def test_add_tags_batch_syncs_each_image(self, test_db):
        id_a = _add_image("/test/rating/e.png")
        id_b = _add_image("/test/rating/f.png")
        db.add_tags_batch(
            [
                {"image_id": id_a, "tags": [{"tag": "general", "confidence": 0.95}]},
                {"image_id": id_b, "tags": [{"tag": "questionable", "confidence": 0.6}]},
            ],
            default_source="tagger",
            replace_scope="pipeline",
        )
        assert _rating_cols(id_a)[0] == "general"
        assert _rating_cols(id_b)[0] == "questionable"

    def test_clear_image_derived_state_clears_rating(self, test_db):
        image_id = _add_image("/test/rating/g.png")
        db.add_tags(image_id, [{"tag": "explicit", "confidence": 0.9}])
        assert _rating_cols(image_id)[0] == "explicit"
        with db.get_db() as conn:
            db_images_write._clear_image_derived_state(conn.cursor(), image_id)
        assert _rating_cols(image_id) == (None, None)


class TestQueryLayerReadsColumn:
    def test_rating_filter_reads_column_not_tag_rows(self, test_db):
        """Regression pin: the filter must consult images.ai_rating, not the
        tag rows. Inject drift (column says explicit, row says general) and
        assert the column verdict wins."""
        image_id = _add_image("/test/rating/h.png")
        db.add_tags(image_id, [{"tag": "general", "confidence": 0.9}])
        conn = sqlite3.connect(db.DATABASE_PATH)
        try:
            conn.execute(
                "UPDATE images SET ai_rating = 'explicit' WHERE id = ?",
                (image_id,),
            )
            conn.commit()
        finally:
            conn.close()

        explicit_ids = [img["id"] for img in db.get_images(ratings=["explicit"])]
        general_ids = [img["id"] for img in db.get_images(ratings=["general"])]
        assert image_id in explicit_ids
        assert image_id not in general_ids

    def test_rating_filter_keeps_untagged_images(self, test_db):
        rated = _add_image("/test/rating/i.png")
        untagged = _add_image("/test/rating/j.png")
        db.add_tags(rated, [{"tag": "explicit", "confidence": 0.9}])
        ids = [img["id"] for img in db.get_images(ratings=["explicit"])]
        assert rated in ids
        assert untagged in ids  # untagged fallback, unchanged semantics

    def test_rating_sort_orders_by_column(self, test_db):
        id_explicit = _add_image("/test/rating/k.png")
        id_general = _add_image("/test/rating/l.png")
        id_unrated = _add_image("/test/rating/m.png")
        db.add_tags(id_explicit, [{"tag": "explicit", "confidence": 0.9}])
        db.add_tags(id_general, [{"tag": "general", "confidence": 0.9}])

        images = db.get_images(sort_by="rating")
        order = [img["id"] for img in images]
        assert order.index(id_explicit) < order.index(id_general) < order.index(id_unrated)

        images_desc = db.get_images(sort_by="rating_desc")
        order_desc = [img["id"] for img in images_desc]
        assert order_desc.index(id_unrated) < order_desc.index(id_general) < order_desc.index(id_explicit)

    def test_exclude_ratings_reads_column_and_keeps_unrated(self, test_db):
        id_explicit = _add_image("/test/rating/n.png")
        id_general = _add_image("/test/rating/o.png")
        id_unrated = _add_image("/test/rating/p.png")
        db.add_tags(id_explicit, [{"tag": "explicit", "confidence": 0.9}])
        db.add_tags(id_general, [{"tag": "general", "confidence": 0.9}])

        ids = [img["id"] for img in db.get_images(exclude_ratings=["explicit"])]
        assert id_explicit not in ids
        assert id_general in ids
        # NULL rating must survive the NOT IN (NULL NOT IN (...) pitfall).
        assert id_unrated in ids
