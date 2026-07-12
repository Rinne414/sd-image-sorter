"""BE-1 endpoints: /api/tags/rethreshold, coverage-gaps, scores/stats, scores/purge.

Seeds stored scores through the same add_tags_batch key the tagging worker
uses, then exercises the endpoints end-to-end (validation, dry-run diff,
apply + provenance survival, consensus fusion, band defaults, maintenance).
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import database as db


def _add_image(path):
    return db.add_image(
        path=path,
        filename=path.rsplit("/", 1)[-1],
        generator="comfyui",
        metadata_json="{}",
    )


def _seed_scores(image_id, model, scores, tags):
    db.add_tags_batch(
        [{
            "image_id": image_id,
            "tags": tags,
            "tag_scores": {"model": model, "scores": scores},
        }],
        default_source="tagger",
        replace_scope="pipeline",
    )


def _tag_names(image_id):
    return {t["tag"] for t in db.get_image_tags(image_id)}


class TestRethreshold:
    def _seed(self):
        """One image tagged at 0.35 with scores stored down to the floor."""
        image_id = _add_image("/test/api/rt.png")
        scores = [
            {"tag": "1girl", "score": 0.97, "category": "general"},
            {"tag": "smile", "score": 0.41, "category": "general"},
            {"tag": "long_hair", "score": 0.30, "category": "general"},
            {"tag": "general", "score": 0.62, "category": "rating"},
        ]
        tags = [
            {"tag": "1girl", "confidence": 0.97, "category": "general"},
            {"tag": "smile", "confidence": 0.41, "category": "general"},
            {"tag": "general", "confidence": 0.62, "category": "rating"},
        ]
        _seed_scores(image_id, "wd-test", scores, tags)
        return image_id

    def test_requires_scope(self, test_client):
        resp = test_client.post("/api/tags/rethreshold", json={"model": "wd-test"})
        assert resp.status_code == 400

    def test_threshold_below_floor_rejected(self, test_client):
        image_id = self._seed()
        resp = test_client.post("/api/tags/rethreshold", json={
            "image_ids": [image_id], "model": "wd-test", "threshold": 0.05,
        })
        assert resp.status_code == 400
        assert "floor" in resp.json()["error"].lower()

    def test_dry_run_reports_diff_without_writing(self, test_client):
        image_id = self._seed()
        resp = test_client.post("/api/tags/rethreshold", json={
            "image_ids": [image_id], "model": "wd-test",
            "threshold": 0.50, "character_threshold": 0.85,
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["dry_run"] is True and body["applied"] is False
        assert body["with_scores"] == 1
        diff = body["diffs"][0]
        assert "smile" in diff["removed"], "0.41 falls under the 0.50 cut"
        assert "smile" in _tag_names(image_id), "dry run must not touch rows"

    def test_apply_rewrites_and_manual_rows_survive(self, test_client):
        image_id = self._seed()
        # User adds a manual tag between runs — it must survive rethreshold.
        merged = db.get_image_tags(image_id) + [
            {"tag": "my_oc_tag", "confidence": 1.0, "source": "manual"}
        ]
        db.add_tags(image_id, merged)

        resp = test_client.post("/api/tags/rethreshold", json={
            "image_ids": [image_id], "model": "wd-test",
            "threshold": 0.50, "character_threshold": 0.85, "dry_run": False,
        })
        assert resp.status_code == 200
        assert resp.json()["applied"] is True
        names = _tag_names(image_id)
        assert "smile" not in names, "below new threshold"
        assert "long_hair" not in names
        assert "1girl" in names
        assert "general" in names, "rating argmax survives any threshold"
        assert "my_oc_tag" in names, "manual rows survive (provenance)"

    def test_lower_threshold_recovers_subthreshold_tags(self, test_client):
        image_id = self._seed()
        resp = test_client.post("/api/tags/rethreshold", json={
            "image_ids": [image_id], "model": "wd-test",
            "threshold": 0.25, "character_threshold": 0.85, "dry_run": False,
        })
        assert resp.status_code == 200
        assert "long_hair" in _tag_names(image_id), (
            "0.30 score resurfaces when the threshold drops to 0.25 — the "
            "whole point of storing sub-threshold scores"
        )

    def test_blacklist_not_resurrected(self, test_client):
        image_id = self._seed()
        resp = test_client.post("/api/tags/rethreshold", json={
            "image_ids": [image_id], "model": "wd-test",
            "threshold": 0.25, "character_threshold": 0.85, "dry_run": False,
            "pre_tag_blacklist": ["long_hair"],
        })
        assert resp.status_code == 200
        assert "long_hair" not in _tag_names(image_id)

    def test_consensus_requires_threshold(self, test_client):
        image_id = self._seed()
        resp = test_client.post("/api/tags/rethreshold", json={
            "image_ids": [image_id], "model": "consensus",
        })
        assert resp.status_code == 400

    def test_consensus_fuses_stored_models(self, test_client):
        image_id = _add_image("/test/api/consensus.png")
        db.add_tags_batch(
            [{
                "image_id": image_id,
                "tags": [{"tag": "1girl", "confidence": 0.9}],
                "tag_scores": [
                    {"model": "wd-a", "scores": [
                        {"tag": "1girl", "score": 0.95, "category": "general"},
                        {"tag": "only_in_a", "score": 0.80, "category": "general"},
                        {"tag": "kayoko", "score": 0.90, "category": "character"},
                    ]},
                    {"model": "wd-b", "scores": [
                        {"tag": "1girl", "score": 0.93, "category": "general"},
                    ]},
                ],
            }],
            default_source="tagger",
            replace_scope="pipeline",
        )
        resp = test_client.post("/api/tags/rethreshold", json={
            "image_ids": [image_id], "model": "consensus",
            "threshold": 0.5, "dry_run": False,
        })
        assert resp.status_code == 200
        body = resp.json()
        assert sorted(body["models_used"]) == ["wd-a", "wd-b"]
        names = _tag_names(image_id)
        assert "1girl" in names, "2 votes >= consensus_min"
        assert "only_in_a" not in names, "1 general vote < consensus_min=2"
        assert "kayoko" in names, "character category bypasses voting (OR semantics)"


class TestCoverageGaps:
    def test_gap_found_and_band_defaults(self, test_client):
        near = _add_image("/test/api/gap1.png")
        _seed_scores(
            near, "wd-test",
            [{"tag": "smile", "score": 0.30, "category": "general"}],
            [{"tag": "1girl", "confidence": 0.9}],
        )
        resp = test_client.post("/api/tags/coverage-gaps", json={
            "tag": "smile", "image_ids": [near],
        })
        assert resp.status_code == 200
        body = resp.json()
        # No model given: defaults band_high=0.35, band_low=0.25.
        assert body["band_high"] == pytest.approx(0.35)
        assert body["band_low"] == pytest.approx(0.25)
        assert body["total"] == 1
        gap = body["gaps"][0]
        assert gap["image_id"] == near
        assert gap["score"] == pytest.approx(0.30)
        assert gap["filename"] == "gap1.png"

    def test_image_with_tag_is_not_a_gap(self, test_client):
        tagged = _add_image("/test/api/gap2.png")
        _seed_scores(
            tagged, "wd-test",
            [{"tag": "smile", "score": 0.30, "category": "general"}],
            [{"tag": "smile", "confidence": 0.30}],
        )
        resp = test_client.post("/api/tags/coverage-gaps", json={
            "tag": "smile", "image_ids": [tagged],
        })
        assert resp.status_code == 200
        assert resp.json()["total"] == 0


class TestMaintenanceEndpoints:
    def test_stats_then_purge(self, test_client):
        image_id = _add_image("/test/api/maint.png")
        _seed_scores(
            image_id, "wd-test",
            [{"tag": "smile", "score": 0.30, "category": "general"}],
            [],
        )
        stats = test_client.get("/api/tags/scores/stats").json()
        assert stats["total_rows"] == 1
        assert stats["models"] == [{"model": "wd-test", "rows": 1, "images": 1}]

        purged = test_client.post("/api/tags/scores/purge", json={}).json()
        assert purged["removed"] == 1
        assert test_client.get("/api/tags/scores/stats").json()["total_rows"] == 0
