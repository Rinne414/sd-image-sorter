"""Tests for the duplicate-group scan service (v3.5.0 Tier 1 cleanup workflow)."""
from __future__ import annotations

import numpy as np
import pytest

from services import duplicate_group_service as dgs
from similarity import embedding_to_bytes


class FakeHandle:
    def __init__(self):
        self.cancel_flag = False
        self.progress = []
        self.result = None

    @property
    def cancelled(self):
        return self.cancel_flag

    def set_progress(self, *, processed=None, total=None, message=None):
        self.progress.append((processed, message))

    def set_result(self, result):
        self.result = result


@pytest.fixture
def dup_env(test_db, tmp_path, monkeypatch):
    monkeypatch.setattr(dgs, "_state_path", lambda: tmp_path / "duplicate-groups.json")
    dgs.set_active_job_id(None)
    yield test_db
    dgs.set_active_job_id(None)


def _insert_image(conn, image_id, filename, vec, *, rating=0, aesthetic=None,
                  width=512, height=512, size=1000):
    conn.execute(
        """
        INSERT INTO images (id, path, filename, width, height, file_size,
                            aesthetic_score, user_rating, embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (image_id, f"C:/t/{filename}", filename, width, height, size,
         aesthetic, rating, embedding_to_bytes(np.asarray(vec, dtype=np.float32))),
    )


def _seed_library(db):
    """3 near-identical reds + 2 unrelated singletons."""
    base = np.zeros(8, dtype=np.float32)
    base[0] = 1.0
    near1 = base + np.array([0, 0.01, 0, 0, 0, 0, 0, 0], dtype=np.float32)
    near2 = base + np.array([0, 0, 0.012, 0, 0, 0, 0, 0], dtype=np.float32)
    other1 = np.zeros(8, dtype=np.float32); other1[3] = 1.0
    other2 = np.zeros(8, dtype=np.float32); other2[5] = 1.0

    conn = db.get_connection()
    try:
        # id 1: low-res but 5 stars; id 2: high aesthetic; id 3: big file
        _insert_image(conn, 1, "a.png", base, rating=5, aesthetic=5.0, width=256, height=256, size=100)
        _insert_image(conn, 2, "b.png", near1, rating=0, aesthetic=9.0, width=1024, height=1024, size=500)
        _insert_image(conn, 3, "c.png", near2, rating=0, aesthetic=6.0, width=2048, height=2048, size=900)
        _insert_image(conn, 4, "d.png", other1)
        _insert_image(conn, 5, "e.png", other2)
        conn.commit()
    finally:
        conn.close()


def _angle_vector(degrees: float) -> np.ndarray:
    radians = np.deg2rad(degrees)
    vector = np.zeros(512, dtype=np.float32)
    vector[0] = np.cos(radians)
    vector[1] = np.sin(radians)
    return vector


def _seed_transitive_chain(db) -> None:
    conn = db.get_connection()
    try:
        _insert_image(
            conn,
            30,
            "chain-a.png",
            _angle_vector(0.0),
            rating=5,
            size=100,
        )
        _insert_image(
            conn,
            31,
            "chain-b.png",
            _angle_vector(17.0),
            rating=0,
            size=200,
        )
        _insert_image(
            conn,
            32,
            "chain-c.png",
            _angle_vector(34.0),
            rating=0,
            size=300,
        )
        conn.commit()
    finally:
        conn.close()


def _assert_transitive_chain_is_safe(data) -> None:
    assert data is not None
    assert data["summary"]["group_count"] == 1
    assert data["summary"]["redundant_count"] == 1
    assert data["summary"]["reclaimable_bytes"] == 200

    group = data["groups"][0]
    assert [member["id"] for member in group["members"]] == [30, 31]
    assert group["members"][0]["suggested_keep"] is True
    assert group["members"][1]["suggested_keep"] is False
    assert group["similarity"] == pytest.approx(
        float(np.cos(np.deg2rad(17.0))), abs=1e-4
    )
    assert all(
        member["id"] != 32
        for candidate_group in data["groups"]
        for member in candidate_group["members"]
        if not member["suggested_keep"]
    )


def _disjoint_pair_graph(
    node_count: int,
) -> tuple[
    list[int],
    dict[int, dict[int, float]],
    dict[int, dict[str, int | float]],
]:
    ids = list(range(node_count))
    metadata = {
        index: {
            "id": index,
            "user_rating": 0,
            "aesthetic_score": 0.0,
            "width": 512,
            "height": 512,
            "file_size": node_count - index,
        }
        for index in ids
    }
    neighbors = {}
    for index in range(0, node_count, 2):
        neighbors[index] = {index + 1: 0.99}
        neighbors[index + 1] = {index: 0.99}
    return ids, neighbors, metadata


def test_partition_ranks_large_disjoint_pairs_once(monkeypatch):
    node_count = 1000
    ids, neighbors, metadata = _disjoint_pair_graph(node_count)

    original_rank_key = dgs._rank_key
    rank_calls = 0

    def counted_rank_key(member):
        nonlocal rank_calls
        rank_calls += 1
        return original_rank_key(member)

    monkeypatch.setattr(dgs, "_rank_key", counted_rank_key)

    groups = dgs._partition_direct_neighbor_groups(
        ids,
        neighbors,
        metadata,
        lambda: False,
    )

    assert groups is not None
    assert len(groups) == node_count // 2
    assert rank_calls == node_count


def test_partition_stops_when_cancellation_is_requested():
    node_count = 1024
    ids, neighbors, metadata = _disjoint_pair_graph(node_count)

    cancellation_checks = 0

    def is_cancelled() -> bool:
        nonlocal cancellation_checks
        cancellation_checks += 1
        return cancellation_checks >= 2

    groups = dgs._partition_direct_neighbor_groups(
        ids,
        neighbors,
        metadata,
        is_cancelled,
    )

    assert groups is None
    assert cancellation_checks == 2


def test_cancel_during_grouping_preserves_last_persisted_result(
    dup_env, monkeypatch
):
    monkeypatch.setattr("similarity_ann.hnswlib_available", lambda: False)
    _seed_library(dup_env)
    state_path = dgs._state_path()
    state_path.write_text(
        '{"version":2,"groups":[],"marker":"previous"}',
        encoding="utf-8",
    )
    handle = FakeHandle()

    def cancel_on_clustering(
        *, processed: int, total: int, message: str
    ) -> None:
        handle.progress.append((processed, message))
        if message == "Clustering groups":
            handle.cancel_flag = True

    handle.set_progress = cancel_on_clustering

    dgs.run_duplicate_scan(handle, threshold=0.95)

    assert dgs.load_result() == {
        "version": 2,
        "groups": [],
        "marker": "previous",
    }
    assert handle.result is None


def test_scan_builds_one_group_with_rating_first_keeper(dup_env, monkeypatch):
    monkeypatch.setattr("similarity_ann.hnswlib_available", lambda: False)
    _seed_library(dup_env)

    handle = FakeHandle()
    dgs.run_duplicate_scan(handle, threshold=0.95)

    data = dgs.load_result()
    assert data is not None
    assert data["version"] == 2
    assert data["summary"]["group_count"] == 1
    assert data["summary"]["redundant_count"] == 2
    group = data["groups"][0]
    member_ids = [m["id"] for m in group["members"]]
    assert sorted(member_ids) == [1, 2, 3]
    # user_rating outranks aesthetic and resolution: id 1 (5 stars) keeps.
    assert group["members"][0]["id"] == 1
    assert group["members"][0]["suggested_keep"] is True
    assert all(m["suggested_keep"] is False for m in group["members"][1:])
    # reclaimable = losers' file sizes (500 + 900)
    assert data["summary"]["reclaimable_bytes"] == 1400
    assert handle.result["summary"]["group_count"] == 1


def test_scan_never_suggests_a_transitive_only_duplicate_for_deletion(
    dup_env, monkeypatch
):
    """Every suggested loser must directly meet the threshold against its keeper."""
    monkeypatch.setattr("similarity_ann.hnswlib_available", lambda: False)
    _seed_transitive_chain(dup_env)

    dgs.run_duplicate_scan(FakeHandle(), threshold=0.95)
    _assert_transitive_chain_is_safe(dgs.load_result())


def test_scan_splits_a_transitive_path_into_direct_keeper_groups(
    dup_env, monkeypatch
):
    monkeypatch.setattr("similarity_ann.hnswlib_available", lambda: False)
    conn = dup_env.get_connection()
    try:
        for image_id, degrees, rating, size in (
            (40, 0.0, 5, 100),
            (41, 17.0, 0, 200),
            (42, 34.0, 4, 300),
            (43, 51.0, 0, 400),
        ):
            _insert_image(
                conn,
                image_id,
                f"path-{image_id}.png",
                _angle_vector(degrees),
                rating=rating,
                size=size,
            )
        conn.commit()
    finally:
        conn.close()

    dgs.run_duplicate_scan(FakeHandle(), threshold=0.95)

    data = dgs.load_result()
    assert data is not None
    assert [
        [member["id"] for member in group["members"]]
        for group in data["groups"]
    ] == [[40, 41], [42, 43]]
    assert data["summary"]["redundant_count"] == 2
    assert data["summary"]["reclaimable_bytes"] == 600


def test_aesthetic_breaks_ties_when_no_ratings(dup_env, monkeypatch):
    monkeypatch.setattr("similarity_ann.hnswlib_available", lambda: False)
    base = np.zeros(8, dtype=np.float32); base[0] = 1.0
    near = base + np.array([0, 0.01, 0, 0, 0, 0, 0, 0], dtype=np.float32)
    conn = dup_env.get_connection()
    try:
        _insert_image(conn, 10, "x.png", base, aesthetic=4.0)
        _insert_image(conn, 11, "y.png", near, aesthetic=8.5)
        conn.commit()
    finally:
        conn.close()

    dgs.run_duplicate_scan(FakeHandle(), threshold=0.95)
    group = dgs.load_result()["groups"][0]
    assert group["members"][0]["id"] == 11


def test_unrelated_images_form_no_groups(dup_env, monkeypatch):
    monkeypatch.setattr("similarity_ann.hnswlib_available", lambda: False)
    conn = dup_env.get_connection()
    try:
        v1 = np.zeros(8, dtype=np.float32); v1[0] = 1.0
        v2 = np.zeros(8, dtype=np.float32); v2[4] = 1.0
        _insert_image(conn, 20, "p.png", v1)
        _insert_image(conn, 21, "q.png", v2)
        conn.commit()
    finally:
        conn.close()

    dgs.run_duplicate_scan(FakeHandle(), threshold=0.95)
    data = dgs.load_result()
    assert data["summary"]["group_count"] == 0
    assert data["groups"] == []


def test_scan_with_too_few_embeddings_persists_empty_result(dup_env):
    dgs.run_duplicate_scan(FakeHandle(), threshold=0.95)
    data = dgs.load_result()
    assert data["version"] == 2
    assert data["summary"]["embedded_count"] == 0
    assert data["summary"]["group_count"] == 0


def test_legacy_v1_group_state_requires_rescan(dup_env):
    state_path = dgs._state_path()
    state_path.write_text('{"version":1,"groups":[]}', encoding="utf-8")

    assert dgs.load_result() is None
    page = dgs.get_groups_page()
    assert page["available"] is False
    assert page["groups"] == []


def test_scan_surfaces_persistence_failure_instead_of_reporting_success(
    dup_env, tmp_path, monkeypatch
):
    blocking_parent = tmp_path / "not-a-directory"
    blocking_parent.write_text("block state directory creation", encoding="utf-8")
    monkeypatch.setattr(
        dgs,
        "_state_path",
        lambda: blocking_parent / "duplicate-groups.json",
    )
    handle = FakeHandle()

    with pytest.raises(dgs.DuplicateGroupPersistenceError, match="duplicate groups"):
        dgs.run_duplicate_scan(handle, threshold=0.95)

    assert handle.result is None


def test_groups_page_pagination_and_missing_state(dup_env, monkeypatch):
    page = dgs.get_groups_page()
    assert page["available"] is False

    monkeypatch.setattr("similarity_ann.hnswlib_available", lambda: False)
    _seed_library(dup_env)
    dgs.run_duplicate_scan(FakeHandle(), threshold=0.95)

    page = dgs.get_groups_page(offset=0, limit=10)
    assert page["available"] is True
    assert page["total_groups"] == 1
    assert page["has_more"] is False
    assert len(page["groups"]) == 1

    empty_page = dgs.get_groups_page(offset=5, limit=10)
    assert empty_page["groups"] == []
    assert empty_page["has_more"] is False


def test_single_scan_slot():
    dgs.set_active_job_id(None)
    assert dgs.set_active_job_id("job-1") is True
    assert dgs.set_active_job_id("job-2") is False
    dgs.set_active_job_id(None)
    assert dgs.set_active_job_id("job-3") is True
    dgs.set_active_job_id(None)


@pytest.mark.skipif(
    not pytest.importorskip("similarity_ann").hnswlib_available(),
    reason="hnswlib not installed",
)
def test_ann_path_matches_exact_path(dup_env):
    _seed_library(dup_env)
    dgs.run_duplicate_scan(FakeHandle(), threshold=0.95)
    data = dgs.load_result()
    assert data["summary"]["group_count"] == 1
    assert sorted(m["id"] for m in data["groups"][0]["members"]) == [1, 2, 3]


@pytest.mark.skipif(
    not pytest.importorskip("similarity_ann").hnswlib_available(),
    reason="hnswlib not installed",
)
def test_ann_path_never_suggests_transitive_only_duplicate_for_deletion(dup_env):
    _seed_transitive_chain(dup_env)

    dgs.run_duplicate_scan(FakeHandle(), threshold=0.95)

    _assert_transitive_chain_is_safe(dgs.load_result())
