"""BE-1 storage layer: tag_scores writes, coverage gaps, stats, purge, cascade.

The table stores every tagger score >= config.TAG_SCORES_FLOOR per
(image, model, tag). Writes ride add_tags_batch's transaction via the
optional per-item ``tag_scores`` key; reads power the re-threshold and
coverage-gap endpoints. These tests pin:

* floor gating + per-(image, model) full replace semantics;
* multi-model sets (Smart Tag persists one set per model);
* coverage gaps: band filter, existing-tag exclusion (case-insensitive),
  best-across-models dedupe, image-id scoping;
* maintenance: stats shape, purge (all / one model);
* lifecycle: image deletion cascades, derived-state clear wipes scores.
"""
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import config
import database as db
import db_images_write


def _add_image(path):
    return db.add_image(
        path=path,
        filename=path.rsplit("/", 1)[-1],
        generator="comfyui",
        metadata_json="{}",
    )


def _write_scores(image_id, model, scores, tags=None):
    db.add_tags_batch(
        [
            {
                "image_id": image_id,
                "tags": tags if tags is not None else [],
                "tag_scores": {"model": model, "scores": scores},
            }
        ],
        default_source="tagger",
        replace_scope="pipeline",
    )


def _raw_rows(image_id=None):
    conn = sqlite3.connect(db.DATABASE_PATH)
    try:
        sql = "SELECT image_id, model, tag, score, category FROM tag_scores"
        params = ()
        if image_id is not None:
            sql += " WHERE image_id = ?"
            params = (image_id,)
        return conn.execute(sql + " ORDER BY model, tag", params).fetchall()
    finally:
        conn.close()


class TestWriteSeam:
    def test_scores_ride_add_tags_batch_and_floor_gates(self, test_db):
        image_id = _add_image("/test/scores/a.png")
        _write_scores(image_id, "wd-test", [
            {"tag": "smile", "score": 0.31, "category": "general"},
            {"tag": "1girl", "score": 0.97, "category": "general"},
            {"tag": "dust", "score": 0.05},  # under floor 0.10 -> dropped
        ])
        rows = _raw_rows(image_id)
        assert [(r[2], r[3]) for r in rows] == [("1girl", 0.97), ("smile", 0.31)]

    def test_retag_fully_replaces_the_model_slice(self, test_db):
        image_id = _add_image("/test/scores/b.png")
        _write_scores(image_id, "wd-test", [{"tag": "old_tag", "score": 0.5}])
        _write_scores(image_id, "wd-test", [{"tag": "new_tag", "score": 0.6}])
        rows = _raw_rows(image_id)
        assert [r[2] for r in rows] == ["new_tag"], "stale scores must not survive a re-tag"

    def test_multi_model_sets_are_independent(self, test_db):
        image_id = _add_image("/test/scores/c.png")
        db.add_tags_batch(
            [
                {
                    "image_id": image_id,
                    "tags": [],
                    "tag_scores": [
                        {"model": "wd-a", "scores": [{"tag": "smile", "score": 0.4}]},
                        {"model": "wd-b", "scores": [{"tag": "smile", "score": 0.7}]},
                    ],
                }
            ],
            default_source="tagger",
            replace_scope="pipeline",
        )
        _write_scores(image_id, "wd-a", [{"tag": "frown", "score": 0.5}])
        rows = _raw_rows(image_id)
        assert ("wd-a", "frown") in [(r[1], r[2]) for r in rows]
        assert ("wd-b", "smile") in [(r[1], r[2]) for r in rows]
        assert ("wd-a", "smile") not in [(r[1], r[2]) for r in rows]

    def test_item_without_tag_scores_leaves_scores_untouched(self, test_db):
        image_id = _add_image("/test/scores/d.png")
        _write_scores(image_id, "wd-test", [{"tag": "smile", "score": 0.4}])
        db.add_tags(image_id, [{"tag": "1girl", "confidence": 0.9}])
        assert len(_raw_rows(image_id)) == 1, "plain tag writes must not clear scores"


class TestCoverageGaps:
    def test_band_and_existing_tag_exclusion(self, test_db):
        has_tag = _add_image("/test/gaps/a.png")
        near_miss = _add_image("/test/gaps/b.png")
        far_miss = _add_image("/test/gaps/c.png")
        _write_scores(has_tag, "wd-test", [{"tag": "smile", "score": 0.33}],
                      tags=[{"tag": "SMILE", "confidence": 0.9}])  # case-insensitive
        _write_scores(near_miss, "wd-test", [{"tag": "smile", "score": 0.30}])
        _write_scores(far_miss, "wd-test", [{"tag": "smile", "score": 0.12}])

        gaps = db.find_coverage_gaps("smile", band_low=0.25, band_high=0.35)
        ids = [g["image_id"] for g in gaps]
        assert near_miss in ids
        assert has_tag not in ids, "images already carrying the tag are not gaps"
        assert far_miss not in ids, "scores under the band are noise, not gaps"
        gap = gaps[ids.index(near_miss)]
        assert gap["score"] == pytest.approx(0.30)
        assert gap["model"] == "wd-test"
        assert gap["filename"] == "b.png"

    def test_best_across_models_and_scope(self, test_db):
        in_scope = _add_image("/test/gaps/d.png")
        out_of_scope = _add_image("/test/gaps/e.png")
        db.add_tags_batch(
            [
                {
                    "image_id": in_scope,
                    "tags": [],
                    "tag_scores": [
                        {"model": "wd-a", "scores": [{"tag": "smile", "score": 0.26}]},
                        {"model": "wd-b", "scores": [{"tag": "smile", "score": 0.31}]},
                    ],
                }
            ],
            default_source="tagger",
            replace_scope="pipeline",
        )
        _write_scores(out_of_scope, "wd-a", [{"tag": "smile", "score": 0.30}])

        gaps = db.find_coverage_gaps(
            "smile", band_low=0.25, band_high=0.35, image_ids=[in_scope]
        )
        assert len(gaps) == 1
        assert gaps[0]["image_id"] == in_scope
        assert gaps[0]["model"] == "wd-b", "best score across models wins"
        assert gaps[0]["score"] == pytest.approx(0.31)

        only_a = db.find_coverage_gaps(
            "smile", band_low=0.25, band_high=0.35,
            image_ids=[in_scope], model="wd-a",
        )
        assert only_a[0]["model"] == "wd-a"

    def test_empty_tag_or_inverted_band_returns_nothing(self, test_db):
        assert db.find_coverage_gaps("", band_low=0.1, band_high=0.5) == []
        assert db.find_coverage_gaps("smile", band_low=0.5, band_high=0.5) == []


class TestMaintenance:
    def test_stats_shape_and_counts(self, test_db):
        image_id = _add_image("/test/stats/a.png")
        _write_scores(image_id, "wd-test", [
            {"tag": "smile", "score": 0.4},
            {"tag": "1girl", "score": 0.9},
        ])
        stats = db.get_tag_score_stats()
        assert stats["enabled"] == bool(config.TAG_SCORES_ENABLED)
        assert stats["floor"] == pytest.approx(config.TAG_SCORES_FLOOR)
        assert stats["total_rows"] == 2
        assert stats["images_with_scores"] == 1
        assert stats["models"] == [{"model": "wd-test", "rows": 2, "images": 1}]
        assert stats["estimated_bytes"] > 0

    def test_purge_one_model_then_all(self, test_db):
        image_id = _add_image("/test/stats/b.png")
        _write_scores(image_id, "wd-a", [{"tag": "smile", "score": 0.4}])
        db.add_tags_batch(
            [{
                "image_id": image_id, "tags": [],
                "tag_scores": {"model": "wd-b", "scores": [{"tag": "smile", "score": 0.5}]},
            }],
            default_source="tagger", replace_scope="pipeline",
        )
        assert db.purge_tag_scores("wd-a") == 1
        assert [r[1] for r in _raw_rows(image_id)] == ["wd-b"]
        assert db.purge_tag_scores() == 1
        assert _raw_rows() == []

    def test_list_score_models_scoped(self, test_db):
        id_a = _add_image("/test/stats/c.png")
        id_b = _add_image("/test/stats/d.png")
        _write_scores(id_a, "wd-a", [{"tag": "smile", "score": 0.4}])
        _write_scores(id_b, "wd-b", [{"tag": "smile", "score": 0.4}])
        all_models = {m["model"] for m in db.list_score_models()}
        assert all_models == {"wd-a", "wd-b"}
        scoped = db.list_score_models(image_ids=[id_a])
        assert scoped == [{"model": "wd-a", "images": 1}]


class TestLifecycle:
    def test_image_delete_cascades_scores(self, test_db):
        image_id = _add_image("/test/life/a.png")
        _write_scores(image_id, "wd-test", [{"tag": "smile", "score": 0.4}])
        assert len(_raw_rows(image_id)) == 1
        db.delete_images_by_ids([image_id])
        assert _raw_rows(image_id) == []

    def test_clear_derived_state_wipes_scores(self, test_db):
        image_id = _add_image("/test/life/b.png")
        _write_scores(image_id, "wd-test", [{"tag": "smile", "score": 0.4}])
        with db.get_db() as conn:
            db_images_write._clear_image_derived_state(conn.cursor(), image_id)
        assert _raw_rows(image_id) == []
