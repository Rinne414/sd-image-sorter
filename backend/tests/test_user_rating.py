"""Tests for the v3.3.2 user_rating feature (FF-2 data layer).

Covers the migration column + index, the ``set_user_rating`` setter and its
range validation, the gallery ``min_user_rating`` ("★≥N") filter, the
``user_rating`` / ``user_rating_asc`` sort, and the
``POST /api/images/{image_id}/rating`` endpoint.

The AI WD14 "rating" *tags* (general/sensitive/questionable/explicit) are a
separate concept and are intentionally not exercised here.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))


def _add(db, path, filename, **kwargs):
    return db.add_image(
        path=path, filename=filename, generator="comfyui",
        metadata_json="{}", **kwargs,
    )


class TestUserRatingColumn:
    def test_migration_adds_column_and_index(self, test_db):
        conn = test_db.get_connection()
        cols = [r[1] for r in conn.execute("PRAGMA table_info(images)")]
        assert "user_rating" in cols
        idx = [r[1] for r in conn.execute("PRAGMA index_list(images)")]
        assert "idx_images_user_rating" in idx

    def test_new_images_default_to_zero(self, test_db):
        iid = _add(test_db, "/lib/u0.png", "u0.png")
        assert test_db.get_image_by_id(iid)["user_rating"] == 0


class TestSetUserRating:
    def test_sets_rating_and_returns_true(self, test_db):
        iid = _add(test_db, "/lib/s.png", "s.png")
        assert test_db.set_user_rating(iid, 4) is True
        assert test_db.get_image_by_id(iid)["user_rating"] == 4

    def test_zero_clears_rating(self, test_db):
        iid = _add(test_db, "/lib/z.png", "z.png")
        test_db.set_user_rating(iid, 5)
        assert test_db.set_user_rating(iid, 0) is True
        assert test_db.get_image_by_id(iid)["user_rating"] == 0

    def test_missing_image_returns_false(self, test_db):
        assert test_db.set_user_rating(999999, 3) is False

    @pytest.mark.parametrize("bad", [-1, 6, 100])
    def test_out_of_range_raises(self, test_db, bad):
        iid = _add(test_db, "/lib/b.png", "b.png")
        with pytest.raises(ValueError):
            test_db.set_user_rating(iid, bad)


class TestUserRatingFilterAndSort:
    def _seed(self, db):
        a = _add(db, "/lib/a.png", "a.png"); db.set_user_rating(a, 5)
        b = _add(db, "/lib/b.png", "b.png"); db.set_user_rating(b, 3)
        _add(db, "/lib/c.png", "c.png")  # unrated (0)
        return a, b

    def test_filter_min_user_rating(self, test_db):
        self._seed(test_db)
        res = test_db.get_images_paginated(min_user_rating=4, limit=50)
        assert sorted(i["filename"] for i in res["images"]) == ["a.png"]
        assert res["total"] == 1

    def test_filter_three_includes_two(self, test_db):
        self._seed(test_db)
        res = test_db.get_images_paginated(min_user_rating=3, limit=50)
        assert res["total"] == 2

    def test_filter_zero_is_noop(self, test_db):
        self._seed(test_db)
        res = test_db.get_images_paginated(min_user_rating=0, limit=50)
        assert res["total"] == 3

    def test_sort_user_rating_desc(self, test_db):
        self._seed(test_db)
        res = test_db.get_images_paginated(sort_by="user_rating", limit=50)
        ratings = [i["user_rating"] for i in res["images"]]
        assert ratings == sorted(ratings, reverse=True)

    def test_sort_user_rating_asc(self, test_db):
        self._seed(test_db)
        res = test_db.get_images_paginated(sort_by="user_rating_asc", limit=50)
        ratings = [i["user_rating"] for i in res["images"]]
        assert ratings == sorted(ratings)


class TestRatingEndpoint:
    def _make_image(self, test_client, tmp_path, name="r.png"):
        from PIL import Image
        p = tmp_path / name
        Image.new("RGB", (16, 16), "white").save(p)
        return test_client.test_db.add_image(
            path=str(p), filename=p.name, metadata_json="{}",
        )

    def test_set_rating_endpoint(self, test_client, tmp_path):
        iid = self._make_image(test_client, tmp_path)
        resp = test_client.post(f"/api/images/{iid}/rating", json={"stars": 4})
        assert resp.status_code == 200
        assert resp.json()["user_rating"] == 4
        assert test_client.test_db.get_image_by_id(iid)["user_rating"] == 4

    def test_clear_rating_endpoint(self, test_client, tmp_path):
        iid = self._make_image(test_client, tmp_path, "clear.png")
        test_client.post(f"/api/images/{iid}/rating", json={"stars": 5})
        resp = test_client.post(f"/api/images/{iid}/rating", json={"stars": 0})
        assert resp.status_code == 200
        assert test_client.test_db.get_image_by_id(iid)["user_rating"] == 0

    def test_unknown_image_returns_404(self, test_client):
        resp = test_client.post("/api/images/999999/rating", json={"stars": 3})
        assert resp.status_code == 404

    @pytest.mark.parametrize("sort_key", ["user_rating", "user_rating_asc"])
    def test_gallery_accepts_user_rating_sort(self, test_client, sort_key):
        # Guards against drift between db_query.VALID_SORT_OPTIONS and the
        # separate gallery allowlist in image_service (a 400 if out of sync).
        resp = test_client.get(f"/api/images?sort_by={sort_key}&limit=1")
        assert resp.status_code == 200

    def test_gallery_accepts_min_user_rating_filter(self, test_client):
        resp = test_client.get("/api/images?min_user_rating=4&limit=1")
        assert resp.status_code == 200

    @pytest.mark.parametrize("bad", [-1, 6, 99])
    def test_out_of_range_rejected(self, test_client, tmp_path, bad):
        iid = self._make_image(test_client, tmp_path, f"bad{bad}.png")
        resp = test_client.post(f"/api/images/{iid}/rating", json={"stars": bad})
        # FastAPI Field ge/le validation; the app's global handler normalizes
        # request-validation errors (422) to a 400 envelope (main.py).
        assert resp.status_code == 400
