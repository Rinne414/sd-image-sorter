"""Style map custom axes (slice S4g): the user defines an axis by example
pictures (POST /api/style-map/custom-axes). Direction, zero point, residual
axes, leave-one-out agreement, missing examples, library scope, duplicate
ends and parallel axes.
"""

from __future__ import annotations

import numpy as np
import pytest

from exceptions import ValidationError
from services import style_map_custom_axes as custom_mod
from services import style_map_service
from tests.test_style_map_regions import _store_kaloscope

DIM = 64
N = 120


def _unit(rows: np.ndarray) -> np.ndarray:
    return rows / np.linalg.norm(rows, axis=1, keepdims=True)


def _vectors(seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """N unit vectors: the first half sits at -1 on a hidden direction u (axis 0),
    the second half at +1; the second hidden direction (axis 1) is a coarser
    split of the same pictures in thirds."""
    rng = np.random.default_rng(seed)
    noise = rng.normal(size=(N, DIM)).astype(np.float32) * 0.25
    side = np.where(np.arange(N) < N // 2, -1.0, 1.0)
    third = np.digitize(np.arange(N), [N // 3, 2 * N // 3]) - 1.0
    noise[:, 0] += side
    noise[:, 1] += third * 0.8
    return _unit(noise), side


def _add_images(test_db, count: int) -> list[int]:
    test_db.add_images_batch(
        [
            {
                "path": f"/nowhere/c{i}.png",
                "filename": f"c{i}.png",
                "content_fingerprint": f"cfp{i}",
            }
            for i in range(count)
        ]
    )
    with test_db.get_db() as conn:
        return [r[0] for r in conn.execute("SELECT id FROM images ORDER BY id")]


@pytest.fixture
def service_map(test_db, monkeypatch):
    monkeypatch.setattr(
        style_map_service.style_map_umap, "umap_available", lambda: False
    )
    ids = _add_images(test_db, N)
    vectors, side = _vectors()
    _store_kaloscope(test_db, ids, vectors)
    service = style_map_service.StyleMapService()
    points = service.points("kaloscope")
    return service, ids, side, points


def _definition(ids, a, b):
    return {"a": [ids[i] for i in a], "b": [ids[i] for i in b]}


# ------------------------------------------------------------ pure math
class TestMath:
    def test_direction_points_from_a_to_b_and_zero_is_halfway(self):
        a = _unit(np.array([[1.0, 0.2, 0], [1.0, -0.2, 0]], dtype=np.float32))
        b = _unit(np.array([[0.2, 1.0, 0], [-0.2, 1.0, 0]], dtype=np.float32))
        direction, middle = custom_mod.axis_direction(a, b)
        assert np.linalg.norm(direction) == pytest.approx(1.0)
        score_a, score_b = (a @ direction).mean(), (b @ direction).mean()
        assert score_a < middle < score_b
        assert score_a - middle == pytest.approx(-(score_b - middle), abs=1e-6)

    def test_identical_ends_have_no_direction(self):
        same = _unit(np.ones((2, 4), dtype=np.float32))
        assert custom_mod.axis_direction(same, same) is None

    def test_leave_one_out_counts_examples_that_stay_on_their_side(self):
        vectors, side = _vectors(1)
        a = vectors[:5]
        b = vectors[-5:]
        assert custom_mod.leave_one_out(a, b) == (10, 10)
        # an example of the wrong end: it falls on the other side
        agree, total = custom_mod.leave_one_out(np.vstack([a, vectors[-1:]]), b)
        assert total == 11 and agree < total

    def test_closed_form_leave_one_out_equals_refitting_each_example(self):
        rng = np.random.default_rng(11)
        for n_a, n_b in ((2, 2), (3, 7), (12, 5)):
            a = _unit(rng.normal(size=(n_a, 16)).astype(np.float32) + 0.4)
            b = _unit(rng.normal(size=(n_b, 16)).astype(np.float32) - 0.2)
            brute = 0
            for own, other, sign in ((a, b, -1.0), (b, a, 1.0)):
                for row in range(len(own)):
                    rest = np.delete(own, row, axis=0)
                    pair = (rest, other) if sign < 0 else (other, rest)
                    found = custom_mod.axis_direction(*pair)
                    if found and sign * (float(own[row] @ found[0]) - found[1]) > 0:
                        brute += 1
            assert custom_mod.leave_one_out(a, b) == (brute, n_a + n_b)

    def test_residual_axes_remove_the_custom_column_from_the_others(self):
        rng = np.random.default_rng(2)
        base = rng.uniform(-1, 1, size=(500, 3))
        custom = base[:, 1] * 0.8 + 0.3 * rng.normal(size=500)
        out = custom_mod.residual_axes(base, {0: custom})
        assert np.allclose(out[:, 0], custom)
        for axis in (1, 2):
            assert abs(np.corrcoef(out[:, axis], custom)[0, 1]) < 1e-9
            assert np.abs(out[:, axis]).max() == pytest.approx(1.0)
        # two custom columns: the remaining axis is free of both
        other = 0.5 * custom + rng.normal(size=500)
        both = custom_mod.residual_axes(base, {0: custom, 1: other})
        for column in (both[:, 0], both[:, 1]):
            assert abs(np.corrcoef(both[:, 2], column)[0, 1]) < 1e-9

    def test_parallel_directions_warn_only_above_the_limit(self):
        d1 = np.array([1.0, 0.0, 0.0], dtype=np.float32)
        near = np.array([0.99, 0.14, 0.0], dtype=np.float32)
        near /= np.linalg.norm(near)
        far = np.array([0.0, 1.0, 0.0], dtype=np.float32)
        warnings = custom_mod.parallel_pairs({"x": d1, "y": near, "z": far})
        assert [w["axes"] for w in warnings] == [["x", "y"]]
        assert warnings[0]["code"] == "axes_parallel"


# -------------------------------------------------------------- service
class TestService:
    def test_the_axis_follows_the_examples_and_zero_sits_between_them(
        self, service_map
    ):
        service, ids, side, points = service_map
        result = service.custom_axes(
            "kaloscope",
            map_id=points["map_id"],
            axes={"x": _definition(ids, [0, 1, 2], [N - 1, N - 2, N - 3])},
        )
        assert result["status"] == "ok"
        order = {pid: row for row, pid in enumerate(result["ids"])}
        placed = [(k, i) for k, i in enumerate(ids) if i in order]
        x = np.array([result["coords"][order[i]][0] for _k, i in placed])
        truth = np.array([side[k] for k, _i in placed])
        assert np.corrcoef(x, truth)[0, 1] > 0.95
        assert x[truth < 0].mean() < 0 < x[truth > 0].mean()
        assert np.abs(x).max() == pytest.approx(1.0, abs=1e-3)
        info = result["axes"]["x"]
        assert info["applied"] and info["agree"] == info["total"] == 6
        assert info["separable"] and info["missing_ids"] == []
        assert result["axes"]["y"] is None and result["warnings"] == []
        # ids and coordinates line up with the points answer
        assert result["ids"] == [p[0] for p in points["points"]]

    def test_zero_is_halfway_between_the_two_example_groups(self, service_map):
        service, ids, side, points = service_map
        placed = [p[0] for p in points["points"]]
        a = [i for i in placed if side[ids.index(i)] < 0][:4]
        b = [i for i in placed if side[ids.index(i)] > 0][:4]
        result = service.custom_axes(
            "kaloscope", map_id=points["map_id"], axes={"x": {"a": a, "b": b}}
        )
        row = {pid: k for k, pid in enumerate(result["ids"])}
        mean_a = np.mean([result["coords"][row[i]][0] for i in a])
        mean_b = np.mean([result["coords"][row[i]][0] for i in b])
        assert mean_a < 0 < mean_b
        assert mean_a == pytest.approx(-mean_b, abs=2e-3)

    def test_other_axes_have_the_custom_one_regressed_out(self, service_map):
        service, ids, side, points = service_map
        result = service.custom_axes(
            "kaloscope",
            map_id=points["map_id"],
            axes={"x": _definition(ids, [0, 1], [N - 1, N - 2])},
        )
        coords = np.array(result["coords"])
        for axis in (1, 2):
            assert abs(np.corrcoef(coords[:, axis], coords[:, 0])[0, 1]) < 1e-3

    def test_no_definition_returns_the_layout_unchanged(self, service_map):
        service, ids, side, points = service_map
        result = service.custom_axes("kaloscope", map_id=points["map_id"], axes={})
        assert result["coords"] == [p[1:4] for p in points["points"]]

    def test_examples_that_do_not_separate_are_reported(self, service_map):
        service, ids, side, points = service_map
        # both "ends" are mixed halves: the direction is noise and the
        # examples do not stay on their side
        a = [0, N - 1, 1, N - 2]
        b = [2, N - 3, 3, N - 4]
        info = service.custom_axes(
            "kaloscope", map_id=points["map_id"], axes={"x": _definition(ids, a, b)}
        )["axes"]["x"]
        assert (
            info["applied"] and not info["separable"] and info["agree"] < info["total"]
        )

    def test_missing_examples_are_listed_and_ignored(self, service_map, test_db):
        service, ids, side, points = service_map
        extra = test_db.add_image(
            path="/nowhere/novec.png", filename="novec.png", content_fingerprint="nv"
        )
        with test_db.get_db() as conn:
            conn.execute(
                "INSERT INTO images (path, filename, content_fingerprint, library_id) VALUES ('/x/o.png','o.png','ofp','other')"
            )
            other = conn.execute(
                "SELECT id FROM images WHERE library_id='other'"
            ).fetchone()[0]
        _store_kaloscope(test_db, [other], _vectors(5)[0][:1])
        result = service.custom_axes(
            "kaloscope",
            map_id=points["map_id"],
            axes={
                "x": {
                    "a": [ids[0], ids[1], extra, other],
                    "b": [ids[-1], ids[-2], 999999],
                }
            },
        )
        info = result["axes"]["x"]
        assert sorted(info["missing_ids"]) == sorted([extra, other, 999999])
        assert info["applied"] and info["total"] == 4

    def test_an_end_with_fewer_than_two_usable_examples_is_not_applied(
        self, service_map, test_db
    ):
        service, ids, side, points = service_map
        extra = test_db.add_image(
            path="/nowhere/novec2.png", filename="novec2.png", content_fingerprint="nv2"
        )
        result = service.custom_axes(
            "kaloscope",
            map_id=points["map_id"],
            axes={"x": {"a": [ids[0], extra], "b": [ids[-1], ids[-2]]}},
        )
        info = result["axes"]["x"]
        assert info["applied"] is False and info["reason"] == "too_few_examples"
        assert info["missing_ids"] == [extra]
        assert result["coords"] == [p[1:4] for p in points["points"]]

    def test_a_picture_in_both_ends_and_a_short_end_are_400s(self, service_map):
        service, ids, side, points = service_map
        with pytest.raises(ValidationError, match="both boxes"):
            service.custom_axes(
                "kaloscope",
                map_id=points["map_id"],
                axes={"x": {"a": [ids[0], ids[1]], "b": [ids[1], ids[2]]}},
            )
        with pytest.raises(ValidationError, match="at least 2"):
            service.custom_axes(
                "kaloscope",
                map_id=points["map_id"],
                axes={"x": {"a": [ids[0]], "b": [ids[1], ids[2]]}},
            )
        with pytest.raises(ValidationError):
            service.custom_axes("kaloscope", map_id=points["map_id"], axes={"w": None})

    def test_two_axes_along_the_same_split_warn(self, service_map):
        service, ids, side, points = service_map
        result = service.custom_axes(
            "kaloscope",
            map_id=points["map_id"],
            axes={
                "x": _definition(ids, range(0, 12), range(N - 12, N)),
                "y": _definition(ids, range(1, 13), range(N - 13, N - 1)),
            },
        )
        assert [w["axes"] for w in result["warnings"]] == [["x", "y"]]

    def test_an_unknown_map_and_a_layout_not_ready_say_so(self, service_map):
        service, ids, side, points = service_map
        assert (
            service.custom_axes("kaloscope", map_id="0" * 32, axes={})["status"]
            == "not_started"
        )
        assert (
            service.custom_axes(
                "kaloscope", map_id=points["map_id"], layout="umap", axes={}
            )["status"]
            == "layout_not_ready"
        )

    def test_malformed_definitions_are_400s_not_500s(self, test_client, monkeypatch):
        from routers import style_map as style_map_router

        monkeypatch.setattr(style_map_service.style_map_umap, "umap_available", lambda: False)
        style_map_router.set_style_map_service(style_map_service.StyleMapService())
        try:
            ids = _add_images(test_client.test_db, 40)
            _store_kaloscope(test_client.test_db, ids, _vectors()[0][:40])
            map_id = test_client.get("/api/style-map/points", params={"space": "kaloscope"}).json()["map_id"]
            for axes in (
                {"x": [1, 2]},
                {"x": "abc"},
                {"x": 5},
                {"x": {"a": 5, "b": ids[:2]}},
                {"x": {"a": "12", "b": ids[:2]}},
                {"x": {"a": [None, ids[0]], "b": ids[1:3]}},
                {"x": {"a": [True, ids[0]], "b": ids[1:3]}},
                {"x": {"a": ["7", ids[0]], "b": ids[1:3]}},
                {"x": {"a": [1.5, ids[0]], "b": ids[1:3]}},
            ):
                response = test_client.post(
                    "/api/style-map/custom-axes",
                    json={"space": "kaloscope", "map_id": map_id, "axes": axes},
                )
                assert response.status_code == 400, (axes, response.status_code, response.text)
        finally:
            style_map_router.set_style_map_service(None)

    def test_route_and_its_400s(self, test_client, monkeypatch):
        from routers import style_map as style_map_router

        monkeypatch.setattr(
            style_map_service.style_map_umap, "umap_available", lambda: False
        )
        style_map_router.set_style_map_service(style_map_service.StyleMapService())
        try:
            ids = _add_images(test_client.test_db, 40)
            _store_kaloscope(test_client.test_db, ids, _vectors()[0][:40])
            map_id = test_client.get(
                "/api/style-map/points", params={"space": "kaloscope"}
            ).json()["map_id"]
            ok = test_client.post(
                "/api/style-map/custom-axes",
                json={
                    "space": "kaloscope",
                    "map_id": map_id,
                    "axes": {"x": {"a": ids[:3], "b": ids[-3:]}},
                },
            )
            assert ok.status_code == 200, ok.text
            assert ok.json()["axes"]["x"]["applied"] is True
            both = test_client.post(
                "/api/style-map/custom-axes",
                json={
                    "space": "kaloscope",
                    "map_id": map_id,
                    "axes": {"x": {"a": ids[:2], "b": ids[1:3]}},
                },
            )
            assert both.status_code == 400 and "both boxes" in both.text
            assert (
                test_client.post(
                    "/api/style-map/custom-axes",
                    json={"space": "kaloscope", "layout": "tsne", "axes": {}},
                ).status_code
                == 400
            )
        finally:
            style_map_router.set_style_map_service(None)
