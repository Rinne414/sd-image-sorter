"""Style map nearest neighbours of a dropped picture (slice S4c).

Pure rules on synthetic vectors (top-k, scores, weak flag, the query point at
the similarity-weighted centre of the three nearest placed neighbours), the
service against the DB (map handle, filter membership, other library), and
the multipart route (size cap, non-image, cross-site origin).
"""

from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image

from services import style_map_query as query_mod
from services import style_map_service
from tests.test_style_map_points import (
    _make_images,
    _official_version,
    _random_units,
    _service,
    _store_kaloscope,
    _store_clip,
    _unit,
)


@pytest.fixture
def no_umap(monkeypatch):
    monkeypatch.setattr(
        style_map_service.style_map_umap, "umap_available", lambda: False
    )


def _png(size=(16, 16), color=(10, 20, 30)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="PNG")
    return buffer.getvalue()


# ------------------------------------------------------------------ pure
class TestRanking:
    def test_top_k_by_cosine_best_first_ties_by_id(self):
        ids = np.array([5, 3, 9, 1], dtype=np.int64)
        matrix = np.array([[1, 0], [0, 1], [1, 0], [0.6, 0.8]], dtype=np.float32)
        ranked = query_mod.rank_by_cosine(np.array([1.0, 0.0]), ids, matrix, 3)
        assert [image_id for image_id, _ in ranked] == [5, 9, 1]
        assert [round(score, 3) for _, score in ranked] == [1.0, 1.0, 0.6]

    def test_k_larger_than_the_library_returns_everything(self):
        ids = np.array([1, 2], dtype=np.int64)
        matrix = np.eye(2, dtype=np.float32)
        assert len(query_mod.rank_by_cosine(np.array([1.0, 0.0]), ids, matrix, 50)) == 2

    def test_query_is_normalised_so_its_length_does_not_matter(self):
        ids = np.array([1, 2], dtype=np.int64)
        matrix = np.eye(2, dtype=np.float32)
        small = query_mod.rank_by_cosine(np.array([0.1, 0.0]), ids, matrix, 2)
        large = query_mod.rank_by_cosine(np.array([40.0, 0.0]), ids, matrix, 2)
        assert small == large and small[0][0] == 1

    def test_empty_matrix_is_empty(self):
        empty = np.zeros((0, 0), dtype=np.float32)
        assert (
            query_mod.rank_by_cosine(
                np.array([1.0]), np.zeros(0, dtype=np.int64), empty, 5
            )
            == []
        )


class TestCentre:
    def test_weighted_by_score_over_the_three_best_placed(self):
        placed = [
            (0.9, (1.0, 0.0, 0.0)),
            (0.6, (0.0, 1.0, 0.0)),
            (0.3, (0.0, 0.0, 1.0)),
            (0.2, (9.0, 9.0, 9.0)),  # fourth: ignored
        ]
        centre = query_mod.weighted_centre(placed)
        assert centre == pytest.approx((0.5, 1 / 3, 1 / 6), abs=1e-3)

    def test_fewer_than_three_and_none(self):
        assert query_mod.weighted_centre([]) is None
        assert query_mod.weighted_centre([(0.5, (0.2, 0.4, 0.6))]) == pytest.approx(
            (0.2, 0.4, 0.6)
        )

    def test_non_positive_scores_fall_back_to_a_plain_mean(self):
        centre = query_mod.weighted_centre(
            [(0.0, (1.0, 0.0, 0.0)), (-0.1, (0.0, 1.0, 0.0))]
        )
        assert centre == pytest.approx((0.5, 0.5, 0.0))


class TestAnswer:
    def test_weak_below_threshold_and_unplaced_are_listed(self):
        ranked = [(3, 0.9), (1, 0.8), (2, 0.4)]
        coords = {1: (0.1, 0.2, 0.3), 2: (0.4, 0.5, 0.6)}
        body = query_mod.build_answer(
            ranked,
            coords,
            filenames={1: "a.png", 2: "b.png", 3: "c.png"},
            weak_threshold=0.5,
            model_version="v1",
        )
        by_id = {n["id"]: n for n in body["neighbors"]}
        assert [n["id"] for n in body["neighbors"]] == [3, 1, 2]  # best first
        assert by_id[1]["weak"] is False and by_id[1]["in_filter"] is True
        assert by_id[2]["weak"] is True and by_id[2]["in_filter"] is True
        assert by_id[3]["in_filter"] is False
        assert by_id[3]["x"] is None and by_id[3]["z"] is None
        assert by_id[3]["filename"] == "c.png"
        assert body["weak_threshold"] == 0.5 and body["model_version"] == "v1"
        # centre only from the placed ones: 0.8 * p1 + 0.4 * p2
        expected = (
            (0.8 * 0.1 + 0.4 * 0.4) / 1.2,
            (0.8 * 0.2 + 0.4 * 0.5) / 1.2,
            (0.8 * 0.3 + 0.4 * 0.6) / 1.2,
        )
        q = body["query"]
        assert (q["x"], q["y"], q["z"]) == pytest.approx(expected, abs=1e-3)

    def test_nothing_placed_means_no_query_point(self):
        body = query_mod.build_answer(
            [(7, 0.9)], {}, filenames={}, weak_threshold=0.25, model_version="v"
        )
        assert body["query"] is None and body["neighbors"][0]["in_filter"] is False


class TestUpload:
    def test_non_image_is_a_validation_error(self):
        from exceptions import ValidationError

        with pytest.raises(ValidationError):
            query_mod.decode_upload_image(b"definitely not a picture")

    def test_image_decodes_to_rgb(self):
        image = query_mod.decode_upload_image(_png())
        assert image.mode == "RGB" and image.size == (16, 16)


# --------------------------------------------------------------- service
@pytest.fixture
def fake_vector(monkeypatch):
    """The Kaloscope forward is replaced by a fixed vector (no model)."""
    holder = {"vector": None, "calls": 0}

    def fake(image, **_kwargs):
        holder["calls"] += 1
        return holder["vector"]

    monkeypatch.setattr(query_mod, "kaloscope_query_vector", fake)
    return holder


def _query(service, handle, space="kaloscope", **kwargs):
    import json

    return json.loads(
        service.query_neighbors_json(
            space, _png(), map_id=handle, k=kwargs.pop("k", 20), **kwargs
        )
    )


class TestService:
    def test_nearest_picture_first_with_coordinates_of_its_point(
        self, test_db, tmp_path, no_umap, fake_vector
    ):
        ids = _make_images(test_db, tmp_path, 8)
        vectors = _random_units(8, seed=5)
        _store_kaloscope(test_db, ids, vectors)
        service = _service()
        points = service.points("kaloscope")
        fake_vector["vector"] = vectors[3] * 3.0  # length is irrelevant

        body = _query(service, points["map_id"])

        assert body["status"] == "ok"
        assert body["model_version"] == _official_version()
        top = body["neighbors"][0]
        assert top["id"] == ids[3] and top["score"] == pytest.approx(1.0, abs=1e-3)
        placed = {p[0]: p[1:4] for p in points["points"]}
        assert (top["x"], top["y"], top["z"]) == tuple(placed[ids[3]])
        scores = [n["score"] for n in body["neighbors"]]
        assert scores == sorted(scores, reverse=True)
        assert top["filename"].startswith("img")
        assert body["weak_threshold"] == query_mod.WEAK_THRESHOLDS["kaloscope"]
        assert body["query"] is not None

    def test_a_picture_outside_the_filter_is_listed_but_not_placed(
        self, test_db, tmp_path, no_umap, fake_vector
    ):
        from services.image_service import ImageService

        ids = _make_images(test_db, tmp_path, 6)
        for image_id, generator in zip(ids, ["nai"] * 3 + ["forge"] * 3):
            with test_db.get_db() as conn:
                conn.execute(
                    "UPDATE images SET generator = ? WHERE id = ?",
                    (generator, image_id),
                )
        vectors = _random_units(6, seed=8)
        _store_kaloscope(test_db, ids, vectors)
        token = ImageService().create_selection_token(generators=["nai"])[
            "selection_token"
        ]
        service = _service()
        points = service.points("kaloscope", selection_token=token)
        assert {p[0] for p in points["points"]} == set(ids[:3])
        fake_vector["vector"] = vectors[4]  # a forge picture, not on this map

        body = _query(service, points["map_id"])

        top = body["neighbors"][0]
        assert top["id"] == ids[4] and top["in_filter"] is False
        assert top["x"] is None
        assert {n["id"] for n in body["neighbors"] if n["in_filter"]} == set(ids[:3])

    def test_unknown_or_evicted_handle_is_not_started_and_runs_no_model(
        self, test_db, tmp_path, no_umap, fake_vector
    ):
        ids = _make_images(test_db, tmp_path, 4)
        _store_kaloscope(test_db, ids, _random_units(4, seed=2))
        service = _service()
        service.points("kaloscope")
        body = _query(service, "f" * 32)
        assert body["status"] == "not_started" and body["neighbors"] == []
        assert body["query"] is None
        assert fake_vector["calls"] == 0

    def test_handle_of_another_space_is_not_started(
        self, test_db, tmp_path, no_umap, fake_vector
    ):
        ids = _make_images(test_db, tmp_path, 4)
        _store_kaloscope(test_db, ids, _random_units(4, seed=2))
        service = _service()
        handle = service.points("kaloscope")["map_id"]
        assert _query(service, handle, space="clip")["status"] == "not_started"

    def test_handle_never_reads_across_libraries(
        self, test_db, tmp_path, no_umap, fake_vector, monkeypatch
    ):
        ids = _make_images(test_db, tmp_path, 4)
        _store_kaloscope(test_db, ids, _random_units(4, seed=2))
        service = _service()
        handle = service.points("kaloscope")["map_id"]
        monkeypatch.setattr(
            "services.style_map_colors.get_current_library_id", lambda: 999
        )
        assert _query(service, handle)["status"] == "not_started"
        assert fake_vector["calls"] == 0

    def test_clip_space_ranks_by_the_similarity_index(
        self, test_db, tmp_path, no_umap, monkeypatch
    ):
        import similarity

        ids = _make_images(test_db, tmp_path, 6)
        vectors = _random_units(6, seed=11)
        _store_clip(test_db, ids, vectors)
        monkeypatch.setattr(
            similarity, "embed_image_pil", lambda _image: vectors[2].copy()
        )
        service = _service()
        points = service.points("clip")

        body = _query(service, points["map_id"], space="clip")

        assert body["status"] == "ok"
        assert body["neighbors"][0]["id"] == ids[2]
        assert body["neighbors"][0]["score"] == pytest.approx(1.0, abs=1e-3)
        assert body["weak_threshold"] == 0.5
        assert body["neighbors"][0]["x"] is not None

    def test_unit_query_scores_match_plain_cosine(
        self, test_db, tmp_path, no_umap, fake_vector
    ):
        ids = _make_images(test_db, tmp_path, 5)
        vectors = _random_units(5, seed=21)
        _store_kaloscope(test_db, ids, vectors)
        service = _service()
        handle = service.points("kaloscope")["map_id"]
        query = _unit(np.random.default_rng(1).normal(size=vectors.shape[1]))
        fake_vector["vector"] = query
        body = _query(service, handle, k=5)
        expected = {i: float(vectors[n] @ query) for n, i in enumerate(ids)}
        for neighbor in body["neighbors"]:
            assert neighbor["score"] == pytest.approx(
                expected[neighbor["id"]], abs=2e-3
            )


# ----------------------------------------------------------------- route
@pytest.fixture
def route(test_client, tmp_path, no_umap, fake_vector):
    from routers import style_map as style_map_router

    service = style_map_service.StyleMapService()
    style_map_router.set_style_map_service(service)
    ids = _make_images(test_client.test_db, tmp_path, 5)
    vectors = _random_units(5, seed=4)
    _store_kaloscope(test_client.test_db, ids, vectors)
    handle = service.points("kaloscope")["map_id"]
    fake_vector["vector"] = vectors[1]
    try:
        yield test_client, handle, ids
    finally:
        style_map_router.set_style_map_service(None)


class TestRoute:
    def test_multipart_upload_answers_with_neighbours(self, route):
        client, handle, ids = route
        response = client.post(
            "/api/style-map/query",
            params={"space": "kaloscope", "map_id": handle},
            files={"file": ("drop.png", _png(), "image/png")},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "ok" and body["neighbors"][0]["id"] == ids[1]

    def test_oversized_upload_is_413(self, route, monkeypatch):
        client, handle, _ids = route
        monkeypatch.setattr(query_mod, "MAX_UPLOAD_BYTES", 100)
        response = client.post(
            "/api/style-map/query",
            params={"space": "kaloscope", "map_id": handle},
            files={"file": ("big.png", _png((64, 64)), "image/png")},
        )
        assert response.status_code == 413

    def test_not_an_image_is_400(self, route):
        client, handle, _ids = route
        response = client.post(
            "/api/style-map/query",
            params={"space": "kaloscope", "map_id": handle},
            files={"file": ("x.txt", b"hello world", "text/plain")},
        )
        assert response.status_code == 400

    def test_empty_file_is_400(self, route):
        client, handle, _ids = route
        response = client.post(
            "/api/style-map/query",
            params={"space": "kaloscope", "map_id": handle},
            files={"file": ("e.png", b"", "image/png")},
        )
        assert response.status_code == 400

    def test_no_file_and_bad_space_are_400(self, route):
        client, handle, _ids = route
        assert (
            client.post("/api/style-map/query", params={"map_id": handle}).status_code
            == 400
        )
        response = client.post(
            "/api/style-map/query",
            params={"space": "csd"},
            files={"file": ("a.png", _png(), "image/png")},
        )
        assert response.status_code == 400

    def test_other_site_origin_is_refused_before_the_upload_is_read(self, route):
        client, handle, _ids = route
        response = client.post(
            "/api/style-map/query",
            params={"space": "kaloscope", "map_id": handle},
            files={"file": ("drop.png", _png(), "image/png")},
            headers={"Origin": "https://evil.example"},
        )
        assert response.status_code == 403

    def test_upload_is_not_written_to_the_library(self, route, tmp_path):
        client, handle, ids = route
        before = sorted(p.name for p in tmp_path.iterdir())
        with client.test_db.get_db() as conn:
            count = conn.execute("SELECT COUNT(*) FROM images").fetchone()[0]
        client.post(
            "/api/style-map/query",
            params={"space": "kaloscope", "map_id": handle},
            files={"file": ("drop.png", _png(), "image/png")},
        )
        with client.test_db.get_db() as conn:
            assert conn.execute("SELECT COUNT(*) FROM images").fetchone()[0] == count
        assert sorted(p.name for p in tmp_path.iterdir()) == before


class TestDisplayedCoordinates:
    def test_neighbours_sit_where_the_page_draws_them_once_umap_is_ready(
        self, test_db, tmp_path, no_umap, fake_vector, monkeypatch
    ):
        ids = _make_images(test_db, tmp_path, 6)
        vectors = _random_units(6, seed=17)
        _store_kaloscope(test_db, ids, vectors)
        service = _service()
        points = service.points("kaloscope")
        rep_ids = np.array([p[0] for p in points["points"]], dtype=np.int64)
        layout = np.arange(len(rep_ids) * 3, dtype=np.float32).reshape(-1, 3) / 100
        monkeypatch.setattr(
            style_map_service.style_map_umap, "umap_available", lambda: True
        )
        monkeypatch.setattr(
            service,
            "_ready_layout",
            lambda _key, _ids: (rep_ids, layout, "memory", 1.0),
        )
        fake_vector["vector"] = vectors[2]

        top = _query(service, points["map_id"])["neighbors"][0]

        row = list(rep_ids).index(ids[2])
        assert (top["x"], top["y"], top["z"]) == pytest.approx(tuple(layout[row]), abs=1e-3)


class TestModelNotPrepared:
    def test_an_unprepared_model_is_a_503_with_the_explaining_sentence(
        self, test_client, tmp_path, no_umap, monkeypatch
    ):
        from exceptions import ServiceError
        from routers import style_map as style_map_router
        from services.style_vector_service import StyleVectorService

        def refuse(self, **_kwargs):
            raise ServiceError("Artist Identify is not prepared on this machine.")

        monkeypatch.setattr(StyleVectorService, "_load_identifier", refuse)
        service = style_map_service.StyleMapService()
        style_map_router.set_style_map_service(service)
        try:
            ids = _make_images(test_client.test_db, tmp_path, 4)
            _store_kaloscope(test_client.test_db, ids, _random_units(4, seed=6))
            handle = service.points("kaloscope")["map_id"]
            response = test_client.post(
                "/api/style-map/query",
                params={"space": "kaloscope", "map_id": handle},
                files={"file": ("drop.png", _png(), "image/png")},
            )
        finally:
            style_map_router.set_style_map_service(None)
        assert response.status_code == 503
        assert "not prepared" in response.text


class TestMergedMembers:
    """A near-duplicate merged into a representative is on the map, at that
    representative's dot; only a picture outside the filter is not."""

    @staticmethod
    def _library(test_db, tmp_path):
        ids = _make_images(test_db, tmp_path, 6)
        vectors = _random_units(6, seed=41)
        noise = _random_units(1, seed=99)[0] * 0.02
        vectors[1] = _unit(vectors[0] + noise)  # id 2 merges into id 1 (smallest id)
        _store_kaloscope(test_db, ids, vectors)
        return ids, vectors

    def test_merged_member_is_flagged_and_sits_on_its_representative(
        self, test_db, tmp_path, no_umap, fake_vector
    ):
        ids, vectors = self._library(test_db, tmp_path)
        service = _service()
        points = service.points("kaloscope")
        placed = {p[0]: tuple(p[1:4]) for p in points["points"]}
        assert ids[1] not in placed and ids[0] in placed  # merged away
        fake_vector["vector"] = vectors[1]

        body = _query(service, points["map_id"])

        member = next(n for n in body["neighbors"] if n["id"] == ids[1])
        assert member["in_filter"] is True and member["merged"] is True
        assert (member["x"], member["y"], member["z"]) == placed[ids[0]]
        rep = next(n for n in body["neighbors"] if n["id"] == ids[0])
        assert rep["merged"] is False and rep["in_filter"] is True
        # both near-identical pictures count for the query point
        assert (body["query"]["x"], body["query"]["y"], body["query"]["z"]) == pytest.approx(
            placed[ids[0]], abs=0.2
        )
        assert all(n["in_filter"] for n in body["neighbors"])

    def test_merged_members_weigh_in_the_centre(self):
        coords = {1: (0.0, 0.0, 0.0), 2: (0.0, 0.0, 0.0), 3: (3.0, 0.0, 0.0)}
        body = query_mod.build_answer(
            [(2, 0.9), (1, 0.9), (3, 0.9)],
            coords,
            filenames={},
            weak_threshold=0.3,
            model_version="v",
            merged={2},
        )
        assert body["query"]["x"] == pytest.approx(1.0, abs=1e-3)
        assert [n["merged"] for n in body["neighbors"]] == [True, False, False]

    def test_outside_the_filter_stays_unplaced_next_to_a_merged_one(
        self, test_db, tmp_path, no_umap, fake_vector
    ):
        from services.image_service import ImageService

        ids, vectors = self._library(test_db, tmp_path)
        for image_id in ids[:3]:
            with test_db.get_db() as conn:
                conn.execute("UPDATE images SET generator = 'nai' WHERE id = ?", (image_id,))
        token = ImageService().create_selection_token(generators=["nai"])["selection_token"]
        service = _service()
        points = service.points("kaloscope", selection_token=token)
        fake_vector["vector"] = vectors[1]

        body = _query(service, points["map_id"])

        by_id = {n["id"]: n for n in body["neighbors"]}
        assert by_id[ids[1]]["merged"] is True and by_id[ids[1]]["in_filter"] is True
        assert by_id[ids[4]]["in_filter"] is False and by_id[ids[4]]["merged"] is False
        assert by_id[ids[4]]["x"] is None


class TestBusyRuntime:
    def test_a_busy_ai_runtime_is_a_409(self, test_client, tmp_path, no_umap, monkeypatch):
        from ai_runtime_guard import AiRuntimeBusyError
        from routers import style_map as style_map_router

        def busy(image, **_kwargs):
            raise AiRuntimeBusyError("another job holds the runtime")

        monkeypatch.setattr(query_mod, "kaloscope_query_vector", busy)
        service = style_map_service.StyleMapService()
        style_map_router.set_style_map_service(service)
        try:
            ids = _make_images(test_client.test_db, tmp_path, 4)
            _store_kaloscope(test_client.test_db, ids, _random_units(4, seed=7))
            handle = service.points("kaloscope")["map_id"]
            response = test_client.post(
                "/api/style-map/query",
                params={"space": "kaloscope", "map_id": handle},
                files={"file": ("drop.png", _png(), "image/png")},
            )
        finally:
            style_map_router.set_style_map_service(None)
        assert response.status_code == 409


class TestUnlocatedNeighbour:
    def test_a_picture_in_the_filter_without_a_dot_is_not_called_outside_it(
        self, test_db, tmp_path, no_umap, fake_vector
    ):
        ids = _make_images(test_db, tmp_path, 6)
        vectors = _random_units(6, seed=51)
        broken = np.zeros_like(vectors[5])
        broken[0] = 1.0  # one component dominates: cannot be placed
        vectors[5] = broken
        _store_kaloscope(test_db, ids, vectors)
        service = _service()
        points = service.points("kaloscope")
        assert ids[5] in points["unlocatable"]
        fake_vector["vector"] = broken

        body = _query(service, points["map_id"])

        top = body["neighbors"][0]
        assert top["id"] == ids[5]
        assert top["in_filter"] is True and top["located"] is False
        assert top["x"] is None
        assert all(n["located"] for n in body["neighbors"][1:])

    def test_a_picture_outside_the_filter_is_neither_in_filter_nor_located(self):
        body = query_mod.build_answer(
            [(9, 0.9)], {}, filenames={}, weak_threshold=0.3, model_version="v"
        )
        assert body["neighbors"][0]["in_filter"] is False
        assert body["neighbors"][0]["located"] is False
