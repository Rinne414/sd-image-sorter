"""Style map: find one picture on the map (slice S4f).

``GET /api/style-map/near`` ranks the library against the STORED vector of one
library picture (no upload, no model), ``POST /api/style-map/locate`` finds the
pictures of the map that match a Gallery search (the search token is the
Gallery's own filter contract) and answers with their dots.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from services import style_map_service
from tests.test_style_map_points import (
    DIM,
    _make_images,
    _random_units,
    _service,
    _store_clip,
    _store_kaloscope,
    _unit,
)


@pytest.fixture
def no_umap(monkeypatch):
    monkeypatch.setattr(
        style_map_service.style_map_umap, "umap_available", lambda: False
    )


def _token(**filters) -> str:
    from services.image_service import ImageService

    return ImageService().create_selection_token(**filters)["selection_token"]


def _near(service, image_id, handle, space="kaloscope", **kwargs):
    return json.loads(
        service.near_json(
            space, image_id, map_id=handle, k=kwargs.pop("k", 20), **kwargs
        )
    )


def _locate(service, handle, token, space="kaloscope", **kwargs):
    return json.loads(service.locate_json(space, token, map_id=handle, **kwargs))


# ------------------------------------------------------------------ near
class TestNear:
    def test_stored_vector_ranks_the_library_and_marks_the_picture_itself(
        self, test_db, tmp_path, no_umap
    ):
        ids = _make_images(test_db, tmp_path, 8)
        vectors = _random_units(8, seed=5)
        _store_kaloscope(test_db, ids, vectors)
        service = _service()
        points = service.points("kaloscope")

        body = _near(service, ids[3], points["map_id"])

        assert body["status"] == "ok"
        assert ids[3] not in [n["id"] for n in body["neighbors"]]
        expected = sorted(
            ((float(vectors[3] @ vectors[n]), ids[n]) for n in range(8) if n != 3),
            reverse=True,
        )
        assert body["neighbors"][0]["id"] == expected[0][1]
        assert body["neighbors"][0]["score"] == pytest.approx(expected[0][0], abs=2e-3)
        placed = {p[0]: p[1:4] for p in points["points"]}
        me = body["self"]
        assert me["id"] == ids[3] and me["filename"] == "img3.png"
        assert me["in_filter"] and me["located"] and not me["merged"]
        assert (me["x"], me["y"], me["z"]) == tuple(placed[ids[3]])
        assert body["query"] == {"x": me["x"], "y": me["y"], "z": me["z"]}
        assert body["weak_threshold"] > 0

    def test_clip_space_reads_the_stored_embedding(self, test_db, tmp_path, no_umap):
        ids = _make_images(test_db, tmp_path, 6)
        vectors = _random_units(6, seed=11)
        _store_clip(test_db, ids, vectors)
        service = _service()
        points = service.points("clip")

        body = _near(service, ids[2], points["map_id"], space="clip")

        assert body["status"] == "ok" and body["self"]["id"] == ids[2]
        assert body["weak_threshold"] == 0.5
        best = max(
            (n for n in range(6) if n != 2), key=lambda n: vectors[2] @ vectors[n]
        )
        assert body["neighbors"][0]["id"] == ids[best]

    def test_picture_without_a_style_vector_says_so(self, test_db, tmp_path, no_umap):
        ids = _make_images(test_db, tmp_path, 6)
        _store_kaloscope(test_db, ids[:5], _random_units(5, seed=3))
        service = _service()
        handle = service.points("kaloscope")["map_id"]

        body = _near(service, ids[5], handle)

        assert body["status"] == "no_vector"
        assert body["neighbors"] == [] and body["self"]["id"] == ids[5]

    def test_clip_picture_without_embedding_says_so(self, test_db, tmp_path, no_umap):
        ids = _make_images(test_db, tmp_path, 6)
        _store_clip(test_db, ids[:5], _random_units(5, seed=3))
        service = _service()
        handle = service.points("clip")["map_id"]
        assert _near(service, ids[5], handle, space="clip")["status"] == "no_vector"

    def test_unknown_picture_is_a_404(self, test_db, tmp_path, no_umap):
        from exceptions import ImageNotFoundError

        ids = _make_images(test_db, tmp_path, 4)
        _store_kaloscope(test_db, ids, _random_units(4, seed=3))
        service = _service()
        handle = service.points("kaloscope")["map_id"]
        with pytest.raises(ImageNotFoundError):
            service.near_json("kaloscope", 987654, map_id=handle, k=5)

    def test_picture_outside_the_filter_is_listed_unplaced(
        self, test_db, tmp_path, no_umap
    ):
        ids = _make_images(test_db, tmp_path, 6)
        for image_id, generator in zip(ids, ["nai"] * 3 + ["forge"] * 3):
            with test_db.get_db() as conn:
                conn.execute(
                    "UPDATE images SET generator = ? WHERE id = ?",
                    (generator, image_id),
                )
        _store_kaloscope(test_db, ids, _random_units(6, seed=8))
        service = _service()
        handle = service.points(
            "kaloscope", selection_token=_token(generators=["nai"])
        )["map_id"]

        body = _near(service, ids[4], handle)

        me = body["self"]
        assert me["in_filter"] is False and me["located"] is False
        assert me["x"] is None and body["query"] is None
        assert {n["id"] for n in body["neighbors"] if n["in_filter"]} <= set(ids[:3])

    def test_merged_picture_sits_on_its_representatives_dot(
        self, test_db, tmp_path, no_umap
    ):
        ids = _make_images(test_db, tmp_path, 6)
        vectors = _random_units(6, seed=41)
        rng = np.random.default_rng(7)
        vectors[1] = _unit(vectors[0] + 0.02 * rng.normal(size=DIM))
        _store_kaloscope(test_db, ids, vectors)
        service = _service()
        points = service.points("kaloscope")
        placed = {p[0]: p[1:4] for p in points["points"]}
        rep = ids[0] if ids[0] in placed else ids[1]
        member = ids[1] if rep == ids[0] else ids[0]
        assert member not in placed

        body = _near(service, member, points["map_id"])

        me = body["self"]
        assert me["merged"] is True and me["located"] is True
        assert (me["x"], me["y"], me["z"]) == tuple(placed[rep])

    def test_unknown_or_foreign_handle_is_not_started(
        self, test_db, tmp_path, no_umap, monkeypatch
    ):
        ids = _make_images(test_db, tmp_path, 4)
        _store_kaloscope(test_db, ids, _random_units(4, seed=2))
        service = _service()
        handle = service.points("kaloscope")["map_id"]
        assert _near(service, ids[0], "f" * 32)["status"] == "not_started"
        monkeypatch.setattr(
            "services.style_map_colors.get_current_library_id", lambda: 999
        )
        assert _near(service, ids[0], handle)["status"] == "not_started"


# ---------------------------------------------------------------- locate
class TestLocate:
    def _map(self, test_db, tmp_path, count=8):
        ids = _make_images(test_db, tmp_path, count)
        _store_kaloscope(test_db, ids, _random_units(count, seed=9))
        service = _service()
        points = service.points("kaloscope")
        return ids, service, points

    def test_search_is_intersected_with_the_map_and_carries_dots(
        self, test_db, tmp_path, no_umap
    ):
        ids, service, points = self._map(test_db, tmp_path)
        placed = {p[0]: p[1:4] for p in points["points"]}

        body = _locate(service, points["map_id"], _token(search="img3"))

        assert body["status"] == "ok" and body["total"] == 1
        hit = body["results"][0]
        assert hit["id"] == ids[3] and hit["filename"] == "img3.png"
        assert (hit["x"], hit["y"], hit["z"]) == tuple(placed[ids[3]])
        assert hit["merged"] is False

    def test_tag_search_uses_the_gallery_contract(self, test_db, tmp_path, no_umap):
        ids, service, points = self._map(test_db, tmp_path)
        test_db.add_tags(ids[2], [{"tag": "blue_hair", "confidence": 0.9}])
        body = _locate(service, points["map_id"], _token(tags=["blue_hair"]))
        assert [r["id"] for r in body["results"]] == [ids[2]]

    def test_results_are_capped_but_the_total_is_not(self, test_db, tmp_path, no_umap):
        ids, service, points = self._map(test_db, tmp_path, count=8)
        body = _locate(service, points["map_id"], _token(search="img"), limit=3)
        assert len(body["results"]) == 3 and body["total"] == 8

    def test_hard_cap_is_fifty(self, test_db, tmp_path, no_umap):
        from services import style_map_locate

        assert style_map_locate.MAX_RESULTS == 50

    def test_merged_member_is_found_at_its_representatives_dot(
        self, test_db, tmp_path, no_umap
    ):
        ids = _make_images(test_db, tmp_path, 6)
        vectors = _random_units(6, seed=41)
        rng = np.random.default_rng(7)
        vectors[1] = _unit(vectors[0] + 0.02 * rng.normal(size=DIM))
        _store_kaloscope(test_db, ids, vectors)
        service = _service()
        points = service.points("kaloscope")
        placed = {p[0]: p[1:4] for p in points["points"]}
        member = ids[1] if ids[0] in placed else ids[0]
        rep = ids[0] if member == ids[1] else ids[1]

        body = _locate(
            service, points["map_id"], _token(search=f"img{ids.index(member)}")
        )

        hit = body["results"][0]
        assert hit["id"] == member and hit["merged"] is True
        assert (hit["x"], hit["y"], hit["z"]) == tuple(placed[rep])

    def test_empty_result_tells_why_the_filter_hides_matches(
        self, test_db, tmp_path, no_umap
    ):
        ids = _make_images(test_db, tmp_path, 6)
        for image_id, generator in zip(ids, ["nai"] * 3 + ["forge"] * 3):
            with test_db.get_db() as conn:
                conn.execute(
                    "UPDATE images SET generator = ? WHERE id = ?",
                    (generator, image_id),
                )
        _store_kaloscope(test_db, ids, _random_units(6, seed=8))
        service = _service()
        handle = service.points(
            "kaloscope", selection_token=_token(generators=["nai"])
        )["map_id"]

        body = _locate(service, handle, _token(search="img4"))

        assert body["results"] == [] and body["total"] == 0
        assert body["outside_filter"] == 1 and body["without_data"] == 0

    def test_empty_result_counts_pictures_without_style_data(
        self, test_db, tmp_path, no_umap
    ):
        ids = _make_images(test_db, tmp_path, 6)
        _store_kaloscope(test_db, ids[:5], _random_units(5, seed=3))
        service = _service()
        handle = service.points("kaloscope")["map_id"]
        body = _locate(service, handle, _token(search="img5"))
        assert body["results"] == []
        assert body["without_data"] == 1 and body["outside_filter"] == 0

    def test_nothing_matching_anywhere_is_plainly_empty(
        self, test_db, tmp_path, no_umap
    ):
        ids, service, points = self._map(test_db, tmp_path)
        body = _locate(service, points["map_id"], _token(search="zzz-nothing"))
        assert body["results"] == [] and body["outside_filter"] == 0
        assert body["without_data"] == 0

    def test_unknown_or_foreign_handle_is_not_started(
        self, test_db, tmp_path, no_umap, monkeypatch
    ):
        ids, service, points = self._map(test_db, tmp_path)
        token = _token(search="img1")
        assert _locate(service, "f" * 32, token)["status"] == "not_started"
        monkeypatch.setattr(
            "services.style_map_colors.get_current_library_id", lambda: 999
        )
        assert _locate(service, points["map_id"], token)["status"] == "not_started"


# ----------------------------------------------------------------- route
@pytest.fixture
def route(test_client, tmp_path, no_umap):
    from routers import style_map as style_map_router

    service = style_map_service.StyleMapService()
    style_map_router.set_style_map_service(service)
    ids = _make_images(test_client.test_db, tmp_path, 5)
    _store_kaloscope(test_client.test_db, ids, _random_units(5, seed=4))
    handle = service.points("kaloscope")["map_id"]
    try:
        yield test_client, handle, ids
    finally:
        style_map_router.set_style_map_service(None)


class TestRoutes:
    def test_near_route(self, route):
        client, handle, ids = route
        response = client.get(
            "/api/style-map/near",
            params={"space": "kaloscope", "map_id": handle, "image_id": ids[1], "k": 3},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "ok" and len(body["neighbors"]) == 3
        assert body["self"]["id"] == ids[1]

    def test_near_route_unknown_picture_is_404(self, route):
        client, handle, _ids = route
        response = client.get(
            "/api/style-map/near",
            params={"space": "kaloscope", "map_id": handle, "image_id": 999999},
        )
        assert response.status_code == 404

    def test_locate_route(self, route):
        client, handle, ids = route
        response = client.post(
            "/api/style-map/locate",
            json={
                "space": "kaloscope",
                "map_id": handle,
                "search_token": _token(search="img2"),
            },
        )
        assert response.status_code == 200, response.text
        assert [r["id"] for r in response.json()["results"]] == [ids[2]]

    def test_locate_route_rejects_a_bad_token(self, route):
        client, handle, _ids = route
        response = client.post(
            "/api/style-map/locate",
            json={"space": "kaloscope", "map_id": handle, "search_token": "garbage"},
        )
        assert response.status_code == 400
