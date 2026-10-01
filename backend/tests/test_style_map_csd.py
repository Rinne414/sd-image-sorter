"""The style map in the CSD space (S5): points, layout status, regions, colours,
members and the dropped-picture query read the ``csd`` vectors and nothing else.

Synthetic 768-d vectors stand in for the model; the service, the cache keys and
the routes are the real ones.
"""

from __future__ import annotations

import io
import json

import numpy as np
import pytest
from PIL import Image

import csd_weights
from db_style_vectors import pack_style_vector
from services import style_map_query as query_mod
from services import style_map_service
from tests.test_style_map_points import (
    _make_images,
    _random_units,
    _service,
    _store_clip,
    _store_kaloscope,
    _unit,
)

CSD_DIM = 768


@pytest.fixture
def no_umap(monkeypatch):
    monkeypatch.setattr(
        style_map_service.style_map_umap, "umap_available", lambda: False
    )


def _store_csd(test_db, image_ids, vectors, version=None):
    version = version or csd_weights.CSD_MODEL_VERSION
    with test_db.get_db() as conn:
        for image_id, vector in zip(image_ids, vectors):
            blob, dim, dtype = pack_style_vector(vector)
            conn.execute(
                "INSERT OR REPLACE INTO image_style_vectors "
                "(image_id, space, model_version, content_fingerprint, dim, dtype, vector, updated_at) "
                "VALUES (?, 'csd', ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))",
                (image_id, version, f"fp{image_ids.index(image_id)}", dim, dtype, blob),
            )


def _png() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (16, 16), (10, 20, 30)).save(buffer, format="PNG")
    return buffer.getvalue()


class TestPoints:
    def test_csd_is_a_map_space_and_reads_its_own_vectors(
        self, test_db, tmp_path, no_umap
    ):
        ids = _make_images(test_db, tmp_path, 8)
        _store_csd(test_db, ids, _random_units(8, seed=1, dim=CSD_DIM))

        body = _service().points("csd")

        assert body["status"] == "ok"
        assert body["model_version"] == csd_weights.CSD_MODEL_VERSION
        assert sorted(p[0] for p in body["points"]) == sorted(ids)

    def test_kaloscope_and_clip_vectors_do_not_make_a_csd_map(
        self, test_db, tmp_path, no_umap
    ):
        ids = _make_images(test_db, tmp_path, 6)
        _store_kaloscope(test_db, ids, _random_units(6, seed=2))
        _store_clip(test_db, ids, _random_units(6, seed=3, dim=32))

        body = _service().points("csd")

        assert body["points"] == []
        assert body["status"] != "ok" or body["total"] == 0

    def test_csd_vectors_do_not_leak_into_the_kaloscope_map(
        self, test_db, tmp_path, no_umap
    ):
        ids = _make_images(test_db, tmp_path, 6)
        _store_csd(test_db, ids, _random_units(6, seed=4, dim=CSD_DIM))

        assert _service().points("kaloscope")["points"] == []

    def test_a_vector_of_other_csd_weights_is_not_on_the_map(
        self, test_db, tmp_path, no_umap
    ):
        ids = _make_images(test_db, tmp_path, 5)
        _store_csd(
            test_db, ids, _random_units(5, seed=5, dim=CSD_DIM), version="csd:old"
        )

        assert _service().points("csd")["points"] == []

    def test_new_csd_vectors_make_a_new_map_not_a_cached_one(
        self, test_db, tmp_path, no_umap
    ):
        ids = _make_images(test_db, tmp_path, 8)
        service = _service()
        _store_csd(test_db, ids[:5], _random_units(5, seed=6, dim=CSD_DIM))
        first = service.points("csd")
        _store_csd(test_db, ids, _random_units(8, seed=6, dim=CSD_DIM))

        second = service.points("csd")

        assert len(first["points"]) == 5 and len(second["points"]) == 8
        assert first["map_id"] != second["map_id"]

    def test_the_local_kaloscope_path_never_changes_the_csd_version(
        self, test_db, tmp_path, no_umap
    ):
        ids = _make_images(test_db, tmp_path, 4)
        _store_csd(test_db, ids, _random_units(4, seed=7, dim=CSD_DIM))

        body = _service().points("csd", model_path=str(tmp_path / "x.pth"))

        assert body["model_version"] == csd_weights.CSD_MODEL_VERSION
        assert len(body["points"]) == 4


class TestDerivedViews:
    def _map(self, test_db, tmp_path):
        ids = _make_images(test_db, tmp_path, 9)
        vectors = _random_units(9, seed=8, dim=CSD_DIM)
        vectors[1] = _unit(vectors[0] + 0.01 * _random_units(1, seed=9, dim=CSD_DIM)[0])
        _store_csd(test_db, ids, vectors)
        service = _service()
        return ids, vectors, service, service.points("csd")

    def test_colours_follow_the_csd_map_in_point_order(
        self, test_db, tmp_path, no_umap
    ):
        _ids, _v, service, points = self._map(test_db, tmp_path)

        body = json.loads(
            service.colors_json("csd", by="generator", map_id=points["map_id"])
        )

        assert body["status"] == "ok"
        assert len(body["values"]) == len(points["points"])

    def test_regions_are_computed_for_the_csd_map(self, test_db, tmp_path, no_umap):
        _ids, _v, service, points = self._map(test_db, tmp_path)

        body = json.loads(service.regions_json("csd", map_id=points["map_id"]))

        assert body["status"] == "ok" and body["space"] == "csd"

    def test_members_expand_the_merged_near_duplicate(self, test_db, tmp_path, no_umap):
        ids, _v, service, points = self._map(test_db, tmp_path)
        rep = ids[0]

        body = json.loads(service.members_json("csd", [rep], map_id=points["map_id"]))

        assert sorted(body["ids"]) == sorted([ids[0], ids[1]])

    def test_layout_status_answers_for_csd(self, test_db, tmp_path, no_umap):
        self._map(test_db, tmp_path)
        body = _service().layout_status("csd")["umap"]
        assert body["status"] in {"unavailable", "not_started", "too_few_points"}


class TestQuery:
    @pytest.fixture
    def fake_csd(self, monkeypatch):
        holder = {"vector": None, "settings": None}

        def fake(image, **settings):
            holder["settings"] = settings
            return holder["vector"]

        monkeypatch.setattr(query_mod, "csd_query_vector", fake)
        return holder

    def test_a_dropped_picture_finds_its_csd_neighbours(
        self, test_db, tmp_path, no_umap, fake_csd
    ):
        ids = _make_images(test_db, tmp_path, 8)
        vectors = _random_units(8, seed=11, dim=CSD_DIM)
        _store_csd(test_db, ids, vectors)
        service = _service()
        points = service.points("csd")
        fake_csd["vector"] = vectors[4] * 2.0

        body = json.loads(
            service.query_neighbors_json(
                "csd", _png(), map_id=points["map_id"], k=5, use_gpu=False
            )
        )

        assert body["status"] == "ok"
        assert body["model_version"] == csd_weights.CSD_MODEL_VERSION
        assert body["neighbors"][0]["id"] == ids[4]
        assert body["neighbors"][0]["score"] == pytest.approx(1.0, abs=1e-3)
        assert body["weak_threshold"] == query_mod.WEAK_THRESHOLDS["csd"]
        assert fake_csd["settings"]["use_gpu"] is False

    def test_the_weak_threshold_sits_between_chance_and_a_real_match(self):
        # Measured on the owner's library (S5 report): random pairs of CSD run
        # much higher than Kaloscope's (mean 0.46), so the line is well above
        # Kaloscope's 0.32 but still below a true near match.
        assert 0.5 < query_mod.WEAK_THRESHOLDS["csd"] < 0.9

    def test_an_unprepared_model_is_a_503_with_the_sentence(
        self, test_client, tmp_path, no_umap, monkeypatch
    ):
        from exceptions import ServiceError
        from routers import style_map as style_map_router
        from services.style_vector_service import StyleVectorService

        def refuse(self, **_kwargs):
            raise ServiceError("CSD is not prepared: click Prepare / Download.")

        monkeypatch.setattr(StyleVectorService, "_load_identifier", refuse)
        service = style_map_service.StyleMapService()
        style_map_router.set_style_map_service(service)
        try:
            ids = _make_images(test_client.test_db, tmp_path, 4)
            _store_csd(test_client.test_db, ids, _random_units(4, seed=12, dim=CSD_DIM))
            handle = service.points("csd")["map_id"]
            response = test_client.post(
                "/api/style-map/query",
                params={"space": "csd", "map_id": handle},
                files={"file": ("drop.png", _png(), "image/png")},
            )
        finally:
            style_map_router.set_style_map_service(None)
        assert response.status_code == 503
        assert "CSD is not prepared" in response.text

    def test_the_real_query_vector_goes_through_the_csd_encoder(self, monkeypatch):
        import csd_encoder

        class Stub:
            def load(self):
                pass

            model_loaded = True

            def extract_style_vectors_and_identifications(self, items, **kwargs):
                self.priority = kwargs["priority"]
                return [(np.ones(CSD_DIM, dtype=np.float32), None)]

        stub = Stub()
        from services.style_vector_service import StyleVectorService

        monkeypatch.setattr(
            StyleVectorService,
            "_load_identifier",
            lambda self, **kwargs: stub if kwargs["space"] == "csd" else None,
        )
        monkeypatch.setattr(csd_encoder, "get_csd_encoder", lambda use_gpu=None: stub)

        vector = query_mod.csd_query_vector(Image.new("RGB", (8, 8)), use_gpu=None)

        from ai_runtime_guard import PRIORITY_INTERACTIVE

        assert vector.shape == (CSD_DIM,) and stub.priority == PRIORITY_INTERACTIVE


class TestRoutes:
    def test_points_and_layout_status_accept_csd(self, test_client, tmp_path, no_umap):
        from routers import style_map as style_map_router

        style_map_router.set_style_map_service(style_map_service.StyleMapService())
        try:
            ids = _make_images(test_client.test_db, tmp_path, 6)
            _store_csd(test_client.test_db, ids, _random_units(6, seed=13, dim=CSD_DIM))
            points = test_client.get("/api/style-map/points", params={"space": "csd"})
            status = test_client.get(
                "/api/style-map/layout-status", params={"space": "csd"}
            )
            bad = test_client.get("/api/style-map/points", params={"space": "dino"})
        finally:
            style_map_router.set_style_map_service(None)
        assert points.status_code == 200 and len(points.json()["points"]) == 6
        assert status.status_code == 200
        assert bad.status_code == 400
