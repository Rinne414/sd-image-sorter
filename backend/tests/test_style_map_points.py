"""Style map points API (slice S2a): PCA layout of the filtered library.

Pure layout math on synthetic vectors, DB-backed selection parity with the
Gallery filter contract (selection tokens), cache hit / invalidation, empty
and no-vector states, and the route. No model is loaded anywhere here.
"""

from __future__ import annotations

import json
import threading
import time

import numpy as np
import pytest
from PIL import Image

import database
from db_style_vectors import pack_style_vector
from exceptions import ValidationError
from similarity_math import embedding_to_bytes
from tests.test_filter_scope_parity import (
    DB_NAMES,
    _canonical_keys,
    _missing,
    _snake,
    _snake_sample,
)


DIM = 64
OFFICIAL = None  # filled lazily: kaloscope_style_vector_model_version(None)


def _official_version() -> str:
    from artist_identifier import kaloscope_style_vector_model_version

    return kaloscope_style_vector_model_version(None)


def _unit(v):
    v = np.asarray(v, dtype=np.float32)
    return v / np.linalg.norm(v)


def _random_units(n: int, seed: int = 0, dim: int = DIM) -> np.ndarray:
    rng = np.random.default_rng(seed)
    x = rng.normal(size=(n, dim)).astype(np.float32)
    return x / np.linalg.norm(x, axis=1, keepdims=True)


def _make_images(test_db, tmp_path, count: int, prefix: str = "img") -> list[int]:
    ids = []
    for index in range(count):
        path = tmp_path / f"{prefix}{index}.png"
        Image.new("RGB", (8, 8), (index * 30 % 255, 90, 120)).save(path)
        ids.append(
            test_db.add_image(
                path=str(path), filename=path.name, content_fingerprint=f"fp{index}"
            )
        )
    return ids


def _store_kaloscope(test_db, image_ids, vectors, version=None):
    version = version or _official_version()
    with test_db.get_db() as conn:
        for image_id, vector in zip(image_ids, vectors):
            blob, dim, dtype = pack_style_vector(vector)
            # Same millisecond stamp the real upsert writes (the table default
            # is CURRENT_TIMESTAMP, second precision).
            conn.execute(
                "INSERT OR REPLACE INTO image_style_vectors "
                "(image_id, space, model_version, content_fingerprint, dim, dtype, vector, updated_at) "
                "VALUES (?, 'kaloscope', ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))",
                (image_id, version, f"fp{image_ids.index(image_id)}", dim, dtype, blob),
            )


def _store_clip(test_db, image_ids, vectors):
    with test_db.get_db() as conn:
        for image_id, vector in zip(image_ids, vectors):
            conn.execute(
                "UPDATE images SET embedding = ? WHERE id = ?",
                (embedding_to_bytes(np.asarray(vector, dtype=np.float32)), image_id),
            )


def _service():
    from services.style_map_service import StyleMapService

    return StyleMapService()


def _clustered(*, seed: int, groups: int, members: int, dim: int):
    """Groups whose members sit at cos ~0.965-0.985 from their centre, so
    member pairs land on both sides of 0.95; ids are shuffled."""
    rng = np.random.default_rng(seed)
    centers = rng.normal(size=(groups, dim))
    labels = rng.integers(0, groups, size=groups * members)
    a = rng.uniform(0.965, 0.985, size=(len(labels), 1))
    noise = rng.normal(size=(len(labels), dim))
    # Even groups live inside the first dim//4 coordinates (the projection
    # keeps almost all of their energy), odd groups spread over every
    # coordinate (a large dropped part). Mixed inside one block, rows differ
    # in dropped energy, which is exactly what the per-block bound must
    # handle: the bound is tight for true duplicates, so a block that used
    # its smallest dropped energy instead of its largest would miss pairs.
    narrow = np.zeros(dim, dtype=bool)
    narrow[: dim // 4] = True
    centers[::2, ~narrow] = 0.0
    centers /= np.linalg.norm(centers, axis=1, keepdims=True)
    noise[np.ix_(labels % 2 == 0, ~narrow)] = 0.0
    noise /= np.linalg.norm(noise, axis=1, keepdims=True)
    a[labels % 2 == 1] = rng.uniform(0.90, 0.94, size=int((labels % 2 == 1).sum()))[
        :, None
    ]
    x = a * centers[labels] + np.sqrt(1 - a * a) * noise
    # Twins: near-copies whose dropped parts are aligned with the original's,
    # the case where the candidate bound is tight (p.p ~ cos - |q|^2).
    twins = x[rng.random(len(x)) < 0.2]
    twin_noise = rng.normal(size=twins.shape)
    twin_noise /= np.linalg.norm(twin_noise, axis=1, keepdims=True)
    twins = twins + 0.12 * twin_noise  # cos(original, twin) ~ 0.993
    x = np.concatenate([x, twins])
    x = (x / np.linalg.norm(x, axis=1, keepdims=True)).astype(np.float32)
    ids = rng.permutation(np.arange(10, 10 + len(x)))
    return x, ids


def _brute_force_groups(ids, x, threshold):
    """All-pairs single linkage: (sorted representative ids, members per rep, pair count)."""
    sims = x @ x.T
    parent = list(range(len(x)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    upper = np.triu(sims, 1) > threshold
    for i, j in zip(*np.where(upper)):
        a, b = find(int(i)), find(int(j))
        if a != b:
            parent[max(a, b)] = min(a, b)
    groups: dict[int, list[int]] = {}
    for i in range(len(x)):
        groups.setdefault(find(i), []).append(int(ids[i]))
    reps = sorted((min(group), len(group)) for group in groups.values())
    return [rep for rep, _ in reps], [count for _, count in reps], int(upper.sum())


# --------------------------------------------------------------------- math
class TestLayoutMath:
    def test_near_duplicates_merge_into_the_smallest_id(self):
        from services.style_map_math import merge_near_duplicates

        base = _random_units(5, seed=1)
        ids = np.array([50, 10, 30, 20, 40, 11, 12], dtype=np.int64)
        # ids 10, 11, 12 are near-duplicates of base[1]; 30/20/40/50 are distinct.
        rng = np.random.default_rng(2)
        near_a = _unit(base[1] + 0.02 * rng.normal(size=DIM))
        near_b = _unit(base[1] + 0.02 * rng.normal(size=DIM))
        x = np.stack(
            [base[0], base[1], base[2], base[3], base[4], near_a, near_b]
        ).astype(np.float32)
        assert float(near_a @ base[1]) > 0.95 and float(near_b @ base[1]) > 0.95

        rep_ids, rep_rows, members = merge_near_duplicates(ids, x, threshold=0.95)

        assert list(rep_ids) == [10, 20, 30, 40, 50]
        assert dict(zip(rep_ids.tolist(), members.tolist())) == {
            10: 3,
            20: 1,
            30: 1,
            40: 1,
            50: 1,
        }
        assert list(rep_rows) == [1, 3, 2, 4, 0]

    def test_merge_is_reproducible_regardless_of_input_order(self):
        from services.style_map_math import merge_near_duplicates

        x = _random_units(40, seed=3)
        rng = np.random.default_rng(4)
        x[10] = _unit(x[3] + 0.04 * rng.normal(size=DIM))
        x[25] = _unit(x[3] + 0.04 * rng.normal(size=DIM))
        ids = np.arange(100, 140)
        first = merge_near_duplicates(ids, x, threshold=0.95)
        perm = rng.permutation(40)
        second = merge_near_duplicates(ids[perm], x[perm], threshold=0.95)
        assert first[0].tolist() == second[0].tolist()
        assert first[2].tolist() == second[2].tolist()

    @pytest.mark.parametrize("seed", [0, 1, 2, 3])
    @pytest.mark.parametrize("block_rows", [97, 1024])
    @pytest.mark.parametrize("candidate_dim", [32, 256])
    def test_merge_matches_exact_pairwise_search(self, seed, block_rows, candidate_dim):
        """Groups of points spread around cos 0.95: the candidate search plus
        full-dimension confirmation must give the all-pairs single-linkage result
        (representatives AND member counts), across several blocks."""
        from services.style_map_math import merge_near_duplicates

        x, ids = _clustered(seed=seed, groups=60, members=40, dim=512)
        expected_reps, expected_members, pairs = _brute_force_groups(ids, x, 0.95)
        assert pairs > 500, "the data must have many pairs across the threshold"

        # candidate_dim=32 leaves a large, uneven dropped energy per row (the
        # narrow even groups keep more than the wide odd groups), so the
        # per-block bound has real slack to get wrong; 256 is the shipped value.
        rep_ids, _rows, members = merge_near_duplicates(
            ids, x, threshold=0.95, block_rows=block_rows, candidate_dim=candidate_dim
        )
        assert rep_ids.tolist() == expected_reps
        assert members.tolist() == expected_members
        assert int(members.sum()) == len(x)

    def test_whole_library_of_near_duplicates_stays_small(self):
        """Every pair is a hit. Without the "already grouped" filter the hit
        arrays grow with n^2 (24k points took 1.9 GB); with it the work is
        bounded by the joins that still change a group."""
        import tracemalloc

        from services.style_map_math import merge_near_duplicates

        n, dim = 12000, 64
        rng = np.random.default_rng(41)
        center = _unit(rng.normal(size=dim))
        noise = rng.normal(size=(n, dim)).astype(np.float32)
        noise /= np.linalg.norm(noise, axis=1, keepdims=True)
        x = (0.99 * center + np.sqrt(1 - 0.99**2) * noise).astype(np.float32)
        x /= np.linalg.norm(x, axis=1, keepdims=True)
        ids = np.arange(1, n + 1)

        tracemalloc.start()
        started = time.perf_counter()
        stats = {}
        rep_ids, _rows, members = merge_near_duplicates(
            ids, x, threshold=0.95, stats=stats
        )
        elapsed = time.perf_counter() - started
        _current, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()

        assert rep_ids.tolist() == [1] and members.tolist() == [n]
        assert peak < 300 * 2**20, f"peak {peak / 2**20:.0f} MiB"
        assert elapsed < 5.0, elapsed
        # Once the first slab has joined everything, no later pair needs
        # confirming: the work stays near one slab's worth, not n^2 / 2.
        from services.style_map_math import _SUB_ROWS

        assert stats["candidate_pairs"] < 4 * _SUB_ROWS * n, stats
        assert stats["duplicate_pairs"] < 4 * _SUB_ROWS * n, stats

    @pytest.mark.parametrize(
        "singletons", [0, 1800], ids=["all-dense", "dense-plus-far"]
    )
    def test_dense_group_stays_within_memory_and_time(self, singletons):
        """A big group where nearly every pair is a candidate must not gather a
        row per pair: peak allocation stays close to the gram block. With far
        singletons around it the candidate columns are a minority, which is
        the gathered-columns branch; without them it is the contiguous one."""
        import tracemalloc

        from services.style_map_math import merge_near_duplicates

        dense, dim = 1200, 256
        rng = np.random.default_rng(30)
        center = _unit(rng.normal(size=dim))
        noise = rng.normal(size=(dense, dim)).astype(np.float32)
        noise /= np.linalg.norm(noise, axis=1, keepdims=True)
        group = (0.985 * center + np.sqrt(1 - 0.985**2) * noise).astype(np.float32)
        x = (
            np.concatenate([group, _random_units(singletons, seed=31, dim=dim)])
            if singletons
            else group
        )
        x = (x / np.linalg.norm(x, axis=1, keepdims=True)).astype(np.float32)
        n = len(x)
        ids = rng.permutation(np.arange(1, n + 1))
        dense_ids = ids[:dense]

        tracemalloc.start()
        started = time.perf_counter()
        stats = {}
        rep_ids, _rows, members = merge_near_duplicates(
            ids, x, threshold=0.95, stats=stats
        )
        elapsed = time.perf_counter() - started
        _current, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()

        by_rep = dict(zip(rep_ids.tolist(), members.tolist()))
        assert by_rep[int(dense_ids.min())] == dense
        assert len(rep_ids) == 1 + singletons
        # The first slab still confirms one row against the whole group before
        # the "already grouped" filter can drop anything.
        assert stats["candidate_pairs"] >= dense - 1, stats
        assert peak < 128 * 2**20, f"peak {peak / 2**20:.0f} MiB"
        assert elapsed < 10.0, elapsed

    def test_unlocatable_points_have_a_dominant_component(self):
        from services.style_map_math import find_unlocatable

        x = _random_units(6, seed=7)
        x[2] = _unit(np.eye(DIM)[3] * 5 + 0.01 * x[2])  # one component ~1
        x[4] = _unit(np.eye(DIM)[9] * 0.8 + 0.3 * x[4])
        mask = find_unlocatable(x, max_component=0.5)
        assert mask.tolist() == [False, False, True, False, True, False]

    def test_pca_layout_shape_range_and_variance(self):
        from services.style_map_math import pca_layout

        rng = np.random.default_rng(8)
        # Anisotropic cloud: three strong directions, then noise.
        latent = rng.normal(size=(500, 3)) * np.array([5.0, 3.0, 1.5])
        basis = np.linalg.qr(rng.normal(size=(DIM, DIM)))[0][:, :3]
        x = (latent @ basis.T + 0.05 * rng.normal(size=(500, DIM))).astype(np.float32)
        x /= np.linalg.norm(x, axis=1, keepdims=True)

        xyz, explained = pca_layout(x)
        assert xyz.shape == (500, 3) and xyz.dtype == np.float32
        assert float(np.abs(xyz).max()) == pytest.approx(1.0, abs=1e-6)
        assert np.all(np.abs(xyz) <= 1.0 + 1e-6)
        assert len(explained) == 3
        assert explained[0] > explained[1] > explained[2] > 0
        assert sum(explained) > 0.9
        assert np.allclose(xyz.mean(axis=0), 0, atol=1e-3)

    def test_pca_layout_handles_tiny_inputs(self):
        from services.style_map_math import pca_layout

        xyz, explained = pca_layout(_random_units(1, seed=9))
        assert xyz.shape == (1, 3) and np.all(xyz == 0)
        assert explained == [0.0, 0.0, 0.0]
        xyz2, explained2 = pca_layout(_random_units(2, seed=10))
        assert xyz2.shape == (2, 3)
        assert len(explained2) == 3


# --------------------------------------------------------------------- service
class TestPoints:
    def test_points_for_the_whole_library(self, test_db, tmp_path):
        ids = _make_images(test_db, tmp_path, 8)
        vectors = _random_units(8, seed=11)
        rng = np.random.default_rng(12)
        vectors[5] = _unit(
            vectors[2] + 0.04 * rng.normal(size=DIM)
        )  # duplicate of ids[2]
        vectors[7] = _unit(np.eye(DIM)[0] * 3 + 0.1 * vectors[7])  # unlocatable
        _store_kaloscope(test_db, ids, vectors)

        result = _service().points("kaloscope")

        assert result["status"] == "ok"
        assert (result["space"], result["method"]) == ("kaloscope", "pca")
        assert result["model_version"] == _official_version()
        assert result["total_images"] == 8
        assert result["missing_vectors"] == 0
        assert result["unlocatable"] == [ids[7]]
        assert result["merged_away"] == 1
        point_ids = [point[0] for point in result["points"]]
        assert ids[5] not in point_ids and ids[7] not in point_ids
        assert set(point_ids) == set(ids) - {ids[5], ids[7]}
        by_id = {point[0]: point for point in result["points"]}
        assert by_id[ids[2]][4] == 2 and by_id[ids[0]][4] == 1
        for point in result["points"]:
            assert len(point) == 5
            assert all(-1.0 <= value <= 1.0 for value in point[1:4])
            assert all(round(value, 3) == value for value in point[1:4])
        assert len(result["explained_variance"]) == 3
        assert result["cached"] is False
        assert result["points_layout"] == ["id", "x", "y", "z", "members"]

    def test_points_follow_the_gallery_filter_token(self, test_db, tmp_path):
        from services.image_service import ImageService

        ids = _make_images(test_db, tmp_path, 6)
        with test_db.get_db() as conn:
            conn.execute(
                f"UPDATE images SET generator = 'nai' WHERE id IN ({ids[1]}, {ids[3]}, {ids[4]})"
            )
        _store_kaloscope(test_db, ids, _random_units(6, seed=13))
        token = ImageService().create_selection_token(generators=["nai"])[
            "selection_token"
        ]
        expected = ImageService().get_filtered_selection_ids(generators=["nai"])[
            "image_ids"
        ]
        assert sorted(expected) == sorted([ids[1], ids[3], ids[4]])

        result = _service().points("kaloscope", selection_token=token)

        assert sorted(point[0] for point in result["points"]) == sorted(expected)
        assert result["total_images"] == 3

    def test_token_reader_forwards_every_gallery_filter(self, test_db, monkeypatch):
        """Same contract as the other token readers in test_filter_scope_parity."""
        from services.image_service import ImageService

        token = ImageService().create_selection_token(
            **_snake_sample(), excluded_image_ids=[424242]
        )["selection_token"]
        seen = []

        def capture(**kwargs):
            seen.append(kwargs)
            return iter(())

        monkeypatch.setattr(database, "iter_filtered_image_id_chunks", capture)
        _service().points("kaloscope", selection_token=token)

        names = [DB_NAMES.get(key, _snake(key)) for key in _canonical_keys()]
        names.append("excluded_image_ids")
        assert len(seen) == 1
        assert not _missing(seen[0], names), (
            f"the style map drops: {_missing(seen[0], names)}"
        )

    def test_invalid_token_is_a_400(self, test_db):
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as info:
            _service().points("kaloscope", selection_token="not-a-token!!")
        assert info.value.status_code == 400

    def test_clip_space_reads_images_embedding(self, test_db, tmp_path):
        ids = _make_images(test_db, tmp_path, 5)
        _store_clip(
            test_db, ids[:4], _random_units(4, seed=14) * 3.0
        )  # unnormalised, like similarity
        result = _service().points("clip")
        assert result["status"] == "ok"
        assert result["space"] == "clip"
        assert sorted(point[0] for point in result["points"]) == sorted(ids[:4])
        assert result["missing_vectors"] == 1
        assert result["model_version"]

    def test_only_current_model_version_counts(self, test_db, tmp_path):
        ids = _make_images(test_db, tmp_path, 4)
        _store_kaloscope(test_db, ids[:2], _random_units(2, seed=15))
        _store_kaloscope(
            test_db,
            ids[2:],
            _random_units(2, seed=16),
            version="kaloscope-local:deadbeef:head.bn",
        )
        result = _service().points("kaloscope")
        assert sorted(point[0] for point in result["points"]) == sorted(ids[:2])
        assert result["missing_vectors"] == 2

    def test_empty_library_and_no_vectors(self, test_db, tmp_path):
        service = _service()
        empty = service.points("kaloscope")
        assert empty["status"] == "empty"
        assert empty["points"] == [] and empty["total_images"] == 0

        ids = _make_images(test_db, tmp_path, 3)
        none = service.points("kaloscope")
        assert none["status"] == "no_vectors"
        assert none["points"] == []
        assert none["missing_vectors"] == 3 and none["total_images"] == 3

        _store_kaloscope(test_db, ids[:1], _random_units(1, seed=17))
        single = service.points("kaloscope")
        assert single["status"] == "ok" and len(single["points"]) == 1
        assert single["points"][0][1:4] == [0.0, 0.0, 0.0]

    def test_rejects_unknown_space(self, test_db):
        with pytest.raises(ValidationError):
            _service().points("csd")

    def test_response_is_compact_json(self, test_db, tmp_path):
        ids = _make_images(test_db, tmp_path, 20)
        _store_kaloscope(test_db, ids, _random_units(20, seed=18))
        result = _service().points("kaloscope")
        encoded = json.dumps(result, separators=(",", ":"))
        per_point = len(encoded) / len(result["points"])
        assert per_point < 60, per_point


class TestCache:
    def test_second_call_hits_the_cache(self, test_db, tmp_path, monkeypatch):
        ids = _make_images(test_db, tmp_path, 5)
        _store_kaloscope(test_db, ids, _random_units(5, seed=19))
        service = _service()
        calls = {"n": 0}
        real = service._compute

        def counting(*args, **kwargs):
            calls["n"] += 1
            return real(*args, **kwargs)

        monkeypatch.setattr(service, "_compute", counting)
        first = service.points("kaloscope")
        second = service.points("kaloscope")
        assert calls["n"] == 1
        assert first["cached"] is False and second["cached"] is True
        assert first["points"] == second["points"]

    def test_new_pictures_without_vectors_invalidate(self, test_db, tmp_path):
        """The picture set is part of the key: a scan that adds pictures must show up."""
        ids = _make_images(test_db, tmp_path, 2)
        _store_kaloscope(test_db, ids, _random_units(2, seed=27))
        service = _service()
        first = service.points("kaloscope")
        assert first["missing_vectors"] == 0
        _make_images(test_db, tmp_path, 2, prefix="late")
        second = service.points("kaloscope")
        assert second["cached"] is False
        assert second["total_images"] == 4 and second["missing_vectors"] == 2

    def test_new_or_changed_vectors_invalidate(self, test_db, tmp_path):
        ids = _make_images(test_db, tmp_path, 5)
        _store_kaloscope(test_db, ids[:4], _random_units(4, seed=20))
        service = _service()
        first = service.points("kaloscope")
        assert len(first["points"]) == 4

        _store_kaloscope(test_db, ids[4:], _random_units(1, seed=21))
        after_add = service.points("kaloscope")
        assert after_add["cached"] is False and len(after_add["points"]) == 5

        # Rewrite one vector right away (same second): the layout must move.
        rewritten = _random_units(1, seed=22)
        _store_kaloscope(test_db, ids[:1], rewritten)
        after_rewrite = service.points("kaloscope")
        assert after_rewrite["cached"] is False
        moved = {p[0]: p[1:4] for p in after_rewrite["points"]}
        before = {p[0]: p[1:4] for p in after_add["points"]}
        assert moved[ids[0]] != before[ids[0]]

    def test_swapping_two_ratings_inside_a_filter_invalidates(self, test_db, tmp_path):
        """Same filtered count, different pictures: the member part of the key
        is the id list itself, not its size."""
        from services.image_service import ImageService

        ids = _make_images(test_db, tmp_path, 3)
        _store_kaloscope(test_db, ids, _random_units(3, seed=31))
        a, b = ids[0], ids[1]
        with test_db.get_db() as conn:
            conn.execute("UPDATE images SET user_rating = 5 WHERE id = ?", (a,))
            conn.execute("UPDATE images SET user_rating = 1 WHERE id = ?", (b,))
        token = ImageService().create_selection_token(min_user_rating=5)[
            "selection_token"
        ]
        service = _service()
        assert [
            p[0] for p in service.points("kaloscope", selection_token=token)["points"]
        ] == [a]

        with test_db.get_db() as conn:
            conn.execute("UPDATE images SET user_rating = 1 WHERE id = ?", (a,))
            conn.execute("UPDATE images SET user_rating = 5 WHERE id = ?", (b,))
        swapped = service.points("kaloscope", selection_token=token)
        assert swapped["cached"] is False
        assert [p[0] for p in swapped["points"]] == [b]

    def test_refresh_recomputes_even_when_cached(self, test_db, tmp_path, monkeypatch):
        ids = _make_images(test_db, tmp_path, 3)
        _store_kaloscope(test_db, ids, _random_units(3, seed=32))
        service = _service()
        calls = {"n": 0}
        real = service._compute

        def counting(*args, **kwargs):
            calls["n"] += 1
            return real(*args, **kwargs)

        monkeypatch.setattr(service, "_compute", counting)
        service.points("kaloscope")
        assert service.points("kaloscope")["cached"] is True
        forced = service.points("kaloscope", refresh=True)
        assert forced["cached"] is False and calls["n"] == 2
        assert service.points("kaloscope")["cached"] is True

    def test_cache_holds_serialized_json(self, test_db, tmp_path):
        ids = _make_images(test_db, tmp_path, 2)
        _store_kaloscope(test_db, ids, _random_units(2, seed=33))
        service = _service()
        service.points("kaloscope")
        payloads = [payload for payload, _stamp in service._cache.values()]
        assert payloads and all(isinstance(payload, bytes) for payload in payloads)
        assert json.loads(payloads[0])["status"] == "ok"

    def test_queued_refreshes_reuse_the_result_computed_while_they_waited(
        self, test_db, tmp_path, monkeypatch
    ):
        ids = _make_images(test_db, tmp_path, 4)
        _store_kaloscope(test_db, ids, _random_units(4, seed=35))
        service = _service()
        service.points("kaloscope")  # warm entry that every refresh must ignore
        calls = {"n": 0}
        real = service._compute

        def slow(*args, **kwargs):
            calls["n"] += 1
            time.sleep(0.3)
            return real(*args, **kwargs)

        monkeypatch.setattr(service, "_compute", slow)
        results = []

        def worker():
            results.append(service.points("kaloscope", refresh=True))

        threads = [threading.Thread(target=worker) for _ in range(3)]
        for thread in threads:
            thread.start()
            time.sleep(0.05)  # the later ones queue behind the first
        for thread in threads:
            thread.join()
        assert calls["n"] == 1, (
            "refreshes queued behind a fresh result must not recompute"
        )
        assert sorted(result["cached"] for result in results) == [False, True, True]
        assert all(result["points"] == results[0]["points"] for result in results)

    def test_clip_recompute_after_rescan_invalidates(self, test_db, tmp_path):
        """Same id, same count: a rescan that saw new pixels rewrites mtime/size
        and the Similarity index re-embeds; the map must not keep the old vector."""
        ids = _make_images(test_db, tmp_path, 3)
        _store_clip(test_db, ids, _random_units(3, seed=36))
        with test_db.get_db() as conn:
            conn.execute("UPDATE images SET source_mtime_ns = 100, source_size = 10")
        service = _service()
        before = service.points("clip")
        assert before["status"] == "ok"

        with test_db.get_db() as conn:  # the rescan: cleared, then re-embedded
            conn.execute(
                "UPDATE images SET embedding = NULL, content_fingerprint = NULL, "
                "source_mtime_ns = 101, source_size = 11 WHERE id = ?",
                (ids[0],),
            )
        _store_clip(test_db, ids[:1], _random_units(1, seed=37))
        after = service.points("clip")
        assert after["cached"] is False
        moved = {p[0]: p[1:4] for p in after["points"]}
        old = {p[0]: p[1:4] for p in before["points"]}
        assert moved[ids[0]] != old[ids[0]]

    def test_different_filters_and_spaces_do_not_share_entries(self, test_db, tmp_path):
        from services.image_service import ImageService

        ids = _make_images(test_db, tmp_path, 4)
        with test_db.get_db() as conn:
            conn.execute(f"UPDATE images SET generator = 'nai' WHERE id = {ids[0]}")
        _store_kaloscope(test_db, ids, _random_units(4, seed=23))
        _store_clip(test_db, ids, _random_units(4, seed=24))
        service = _service()
        everything = service.points("kaloscope")
        token = ImageService().create_selection_token(generators=["nai"])[
            "selection_token"
        ]
        filtered = service.points("kaloscope", selection_token=token)
        clip = service.points("clip")
        assert len(everything["points"]) == 4
        assert [point[0] for point in filtered["points"]] == [ids[0]]
        assert filtered["cached"] is False and clip["cached"] is False
        assert service.points("kaloscope")["cached"] is True

    def test_concurrent_requests_compute_once(self, test_db, tmp_path, monkeypatch):
        ids = _make_images(test_db, tmp_path, 5)
        _store_kaloscope(test_db, ids, _random_units(5, seed=25))
        service = _service()
        calls = {"n": 0}
        real = service._compute

        def slow(*args, **kwargs):
            calls["n"] += 1
            time.sleep(0.3)
            return real(*args, **kwargs)

        monkeypatch.setattr(service, "_compute", slow)
        results = []

        def worker():
            results.append(service.points("kaloscope"))

        threads = [threading.Thread(target=worker) for _ in range(3)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert calls["n"] == 1, "the second request waits for the first and reuses it"
        assert len(results) == 3
        assert all(result["points"] == results[0]["points"] for result in results)


# --------------------------------------------------------------------- router
class TestBlasLimit:
    """The map's matmuls run on a bounded number of BLAS threads and only the
    map: the limit applies during ``_compute`` and is gone afterwards."""

    @staticmethod
    def _blas_threads() -> list[int]:
        from threadpoolctl import threadpool_info

        return [
            int(info["num_threads"])
            for info in threadpool_info()
            if info["user_api"] == "blas"
        ]

    def test_compute_runs_on_four_blas_threads_and_restores_after(
        self, test_db, tmp_path, monkeypatch
    ):
        from services import style_map_service

        if not self._blas_threads():
            pytest.skip("no BLAS library loaded in this interpreter")
        ids = _make_images(test_db, tmp_path, 4)
        _store_kaloscope(test_db, ids, _random_units(4, seed=40))
        service = _service()
        outside_before = self._blas_threads()
        seen: list[list[int]] = []
        real = service._compute

        def observing(*args, **kwargs):
            seen.append(self._blas_threads())
            return real(*args, **kwargs)

        monkeypatch.setattr(service, "_compute", observing)
        assert service.points("kaloscope")["status"] == "ok"

        assert seen and all(
            threads == [style_map_service.STYLE_MAP_BLAS_THREADS] * len(threads)
            for threads in seen
        ), seen
        assert style_map_service.STYLE_MAP_BLAS_THREADS == 4
        assert self._blas_threads() == outside_before, (
            "the limit must not leak out of the map"
        )


class TestRoute:
    def test_route_is_mounted_and_sync(self, test_client):
        import inspect

        from main import app
        from routers import style_map

        assert "/api/style-map/points" in {route.path for route in app.routes}
        assert not inspect.iscoroutinefunction(style_map.style_map_points)

    def test_route_returns_points(self, test_client, tmp_path):
        ids = _make_images(test_client.test_db, tmp_path, 3)
        _store_kaloscope(test_client.test_db, ids, _random_units(3, seed=26))
        response = test_client.get(
            "/api/style-map/points", params={"space": "kaloscope"}
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "ok" and len(body["points"]) == 3

    @pytest.mark.parametrize(
        "params", [{"space": "csd"}, {"space": "kaloscope", "selection_token": "bad!"}]
    )
    def test_route_rejects_bad_requests(self, test_client, params):
        response = test_client.get("/api/style-map/points", params=params)
        assert response.status_code == 400

    def test_route_refresh_bypasses_the_cache(self, test_client, tmp_path):
        ids = _make_images(test_client.test_db, tmp_path, 2)
        _store_kaloscope(test_client.test_db, ids, _random_units(2, seed=34))
        first = test_client.get(
            "/api/style-map/points", params={"space": "kaloscope"}
        ).json()
        second = test_client.get(
            "/api/style-map/points", params={"space": "kaloscope"}
        ).json()
        forced = test_client.get(
            "/api/style-map/points", params={"space": "kaloscope", "refresh": "true"}
        ).json()
        assert (first["cached"], second["cached"], forced["cached"]) == (
            False,
            True,
            False,
        )
        assert forced["points"] == first["points"]
