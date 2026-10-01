"""Style map merged members (slice S4b): which pictures hide behind a dot.

The map shows one representative per near-duplicate group. A box selection
must act on every picture the dots stand for, so the service keeps the
group table beside the cached map and ``POST /api/style-map/members``
expands representatives into all member ids (never across libraries, never
for an evicted map).
"""

from __future__ import annotations

import numpy as np
import pytest

from services import style_map_members as members_mod
from services import style_map_service
from tests.test_style_map_points import (
    DIM,
    _make_images,
    _random_units,
    _service,
    _store_kaloscope,
    _unit,
)


@pytest.fixture
def no_umap(monkeypatch):
    monkeypatch.setattr(
        style_map_service.style_map_umap, "umap_available", lambda: False
    )


def _library(test_db, tmp_path):
    """6 pictures; ids[1] and ids[2] are near-duplicates of ids[0]."""
    ids = _make_images(test_db, tmp_path, 6)
    vectors = _random_units(6, seed=41)
    rng = np.random.default_rng(7)
    vectors[1] = _unit(vectors[0] + 0.02 * rng.normal(size=DIM))
    vectors[2] = _unit(vectors[0] + 0.02 * rng.normal(size=DIM))
    _store_kaloscope(test_db, ids, vectors)
    return ids


# --------------------------------------------------------------------- math
class TestGroupTable:
    def test_merge_reports_the_members_of_every_group(self):
        from services.style_map_math import merge_near_duplicates

        base = _random_units(4, seed=1)
        rng = np.random.default_rng(2)
        near = [_unit(base[1] + 0.02 * rng.normal(size=DIM)) for _ in range(2)]
        ids = np.array([50, 10, 30, 20, 11, 12], dtype=np.int64)
        x = np.stack([base[0], base[1], base[2], base[3], *near]).astype(np.float32)
        groups: dict = {}

        rep_ids, _rows, counts = merge_near_duplicates(
            ids, x, threshold=0.95, groups=groups
        )

        assert list(rep_ids) == [10, 20, 30, 50]
        assert list(groups["offsets"]) == [0, 3, 4, 5, 6]
        table = {
            int(rep): sorted(groups["member_ids"][lo:hi].tolist())
            for rep, lo, hi in zip(
                rep_ids, groups["offsets"][:-1], groups["offsets"][1:]
            )
        }
        assert table == {10: [10, 11, 12], 20: [20], 30: [30], 50: [50]}
        assert counts.tolist() == [3, 1, 1, 1]

    def test_group_table_is_the_same_for_any_input_order(self):
        from services.style_map_math import merge_near_duplicates

        base = _random_units(3, seed=5)
        rng = np.random.default_rng(6)
        x = np.stack(
            [base[0], base[1], _unit(base[0] + 0.02 * rng.normal(size=DIM)), base[2]]
        ).astype(np.float32)
        ids = np.array([4, 2, 3, 1], dtype=np.int64)
        perm = np.array([3, 0, 2, 1])
        first: dict = {}
        second: dict = {}
        merge_near_duplicates(ids, x, threshold=0.95, groups=first)
        merge_near_duplicates(ids[perm], x[perm], threshold=0.95, groups=second)
        assert first["member_ids"].tolist() == second["member_ids"].tolist()
        assert first["offsets"].tolist() == second["offsets"].tolist()


class TestExpand:
    TABLE = (
        np.array([1, 2, 3, 4, 5], dtype=np.int64),  # member ids by group
        np.array([0, 2, 3, 5], dtype=np.int64),  # offsets
        np.array([1, 3, 4], dtype=np.int64),  # representatives
    )

    def test_representatives_expand_to_every_member(self):
        member_ids, offsets, reps = self.TABLE
        assert members_mod.expand(reps, member_ids, offsets, [1, 4]) == [1, 2, 4, 5]

    def test_a_non_representative_or_unknown_id_expands_to_nothing(self):
        member_ids, offsets, reps = self.TABLE
        assert members_mod.expand(reps, member_ids, offsets, [2, 99]) == []

    def test_owner_of_a_member_is_its_representative(self):
        member_ids, offsets, reps = self.TABLE
        found = members_mod.owners(reps, member_ids, offsets, [2, 5, 3, 77])
        assert found == {2: 1, 5: 4, 3: 3}


# ------------------------------------------------------------------ service
class TestService:
    def test_a_representative_expands_to_its_merged_pictures(
        self, test_db, tmp_path, no_umap
    ):
        ids = _library(test_db, tmp_path)
        service = _service()
        points = service.points("kaloscope")
        assert {p[0] for p in points["points"]} == {ids[0], ids[3], ids[4], ids[5]}

        body = service.members(
            "kaloscope", rep_ids=[ids[0], ids[3]], map_id=points["map_id"]
        )

        assert body["status"] == "ok"
        assert sorted(body["ids"]) == sorted([ids[0], ids[1], ids[2], ids[3]])

    def test_a_merged_member_is_not_a_representative(self, test_db, tmp_path, no_umap):
        ids = _library(test_db, tmp_path)
        service = _service()
        handle = service.points("kaloscope")["map_id"]
        body = service.members("kaloscope", rep_ids=[ids[1]], map_id=handle)
        assert body["status"] == "ok" and body["ids"] == []

    def test_unknown_handle_is_not_started(self, test_db, tmp_path, no_umap):
        ids = _library(test_db, tmp_path)
        service = _service()
        service.points("kaloscope")
        body = service.members("kaloscope", rep_ids=[ids[0]], map_id="f" * 32)
        assert body == {"status": "not_started", "space": "kaloscope", "ids": []}

    def test_evicted_map_is_not_started(self, test_db, tmp_path, no_umap):
        ids = _library(test_db, tmp_path)
        service = _service()
        handle = service.points("kaloscope")["map_id"]
        service.clear_cache()
        body = service.members("kaloscope", rep_ids=[ids[0]], map_id=handle)
        assert body["status"] == "not_started" and body["ids"] == []

    def test_handle_never_reads_across_libraries(
        self, test_db, tmp_path, no_umap, monkeypatch
    ):
        ids = _library(test_db, tmp_path)
        service = _service()
        handle = service.points("kaloscope")["map_id"]
        monkeypatch.setattr(
            "services.style_map_colors.get_current_library_id", lambda: 999
        )
        body = service.members("kaloscope", rep_ids=[ids[0]], map_id=handle)
        assert body["status"] == "not_started" and body["ids"] == []

    def test_without_a_handle_the_filter_locates_the_map(
        self, test_db, tmp_path, no_umap
    ):
        ids = _library(test_db, tmp_path)
        service = _service()
        service.points("kaloscope")
        body = service.members("kaloscope", rep_ids=[ids[0]])
        assert sorted(body["ids"]) == sorted(ids[:3])


# -------------------------------------------------------------------- route
class TestRoute:
    def test_post_members(self, test_client, tmp_path, no_umap):
        from routers import style_map as style_map_router

        style_map_router.set_style_map_service(style_map_service.StyleMapService())
        try:
            ids = _library(test_client.test_db, tmp_path)
            handle = test_client.get(
                "/api/style-map/points", params={"space": "kaloscope"}
            ).json()["map_id"]
            response = test_client.post(
                "/api/style-map/members",
                json={"space": "kaloscope", "map_id": handle, "rep_ids": [ids[0]]},
            )
            assert response.status_code == 200
            assert sorted(response.json()["ids"]) == sorted(ids[:3])
            gone = test_client.post(
                "/api/style-map/members",
                json={"space": "kaloscope", "map_id": "e" * 32, "rep_ids": [ids[0]]},
            )
            assert gone.json()["status"] == "not_started"
        finally:
            style_map_router.set_style_map_service(None)

    def test_bad_bodies_are_refused(self, test_client):
        for body in (
            {"space": "nope", "rep_ids": [1]},
            {"space": "kaloscope", "map_id": "short", "rep_ids": [1]},
            {"space": "kaloscope", "rep_ids": ["x"]},
            {"space": "kaloscope"},
        ):
            response = test_client.post("/api/style-map/members", json=body)
            assert response.status_code in (400, 422), body

    def test_map_id_never_reads_across_libraries(self, test_client, tmp_path, no_umap):
        from routers import style_map as style_map_router

        style_map_router.set_style_map_service(style_map_service.StyleMapService())
        try:
            ids = _library(test_client.test_db, tmp_path)
            handle = test_client.get(
                "/api/style-map/points", params={"space": "kaloscope"}
            ).json()["map_id"]
            body = {"space": "kaloscope", "map_id": handle, "rep_ids": [ids[0]]}
            other = test_client.post(
                "/api/style-map/members", json=body, headers={"X-SD-Library-Id": "libB"}
            ).json()
            assert other["status"] == "not_started" and other["ids"] == []
            own = test_client.post("/api/style-map/members", json=body).json()
            assert own["status"] == "ok" and len(own["ids"]) == 3
        finally:
            style_map_router.set_style_map_service(None)
