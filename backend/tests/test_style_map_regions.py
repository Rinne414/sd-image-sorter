"""Style map regions (slice S3b.1): k-means regions on the displayed layout,
representative pictures, WD14 style-tag labels (whitelist + hypergeometric
significance over TAGGED pictures only) and artist labels (confident tier
only), served by GET /api/style-map/regions from the same layout cache key.
"""

from __future__ import annotations

import math

import numpy as np
import pytest
from PIL import Image

from db_style_vectors import pack_style_vector
from services import style_map_regions as regions_mod
from services import style_map_service

DIM = 64


def _random_units(n: int, seed: int = 0, dim: int = DIM) -> np.ndarray:
    rng = np.random.default_rng(seed)
    x = rng.normal(size=(n, dim)).astype(np.float32)
    return x / np.linalg.norm(x, axis=1, keepdims=True)


def _blobs(n_per: int, centers: np.ndarray, spread: float, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    rows = []
    for center in centers:
        rows.append(center + rng.normal(scale=spread, size=(n_per, centers.shape[1])))
    return np.concatenate(rows).astype(np.float32)


# ------------------------------------------------------------ pure pieces
class TestMath:
    def test_hypergeometric_tail_matches_scipy(self):
        scipy_stats = pytest.importorskip("scipy.stats")
        cases = [
            (1, 100, 10, 20),
            (4, 957, 156, 267),
            (12, 957, 27, 267),
            (0, 50, 5, 10),
            (5, 50, 5, 10),
            (3, 30, 3, 3),
        ]
        for c, total, successes, draws in cases:
            ours = regions_mod.hypergeom_tail(c, total, successes, draws)
            ref = float(scipy_stats.hypergeom.sf(c - 1, total, successes, draws))
            assert abs(ours - ref) < 1e-6, (c, total, successes, draws, ours, ref)

    def test_hypergeometric_tail_edges(self):
        assert regions_mod.hypergeom_tail(0, 10, 3, 4) == pytest.approx(1.0)
        assert regions_mod.hypergeom_tail(5, 10, 3, 4) == 0.0
        # P(X >= 1) drawing 4 of 10 with 3 successes = 1 - C(7,4)/C(10,4) = 1 - 35/210
        assert regions_mod.hypergeom_tail(1, 10, 3, 4) == pytest.approx(
            1 - 35 / 210, abs=1e-9
        )

    def test_benjamini_hochberg_adjusts_for_the_number_of_tests(self):
        assert regions_mod.benjamini_hochberg([]) == []
        assert regions_mod.benjamini_hochberg([0.004]) == [pytest.approx(0.004)]
        qs = regions_mod.benjamini_hochberg([0.004, 0.5, 0.3, 0.2, 0.9])
        # ranks: 0.004(1) 0.2(2) 0.3(3) 0.5(4) 0.9(5); q = min over higher ranks of p*m/rank
        assert qs == [
            pytest.approx(0.02),
            pytest.approx(0.625),
            pytest.approx(0.5),
            pytest.approx(0.5),
            pytest.approx(0.9),
        ]
        assert regions_mod.benjamini_hochberg([0.9, 0.95]) == [
            pytest.approx(0.95),
            pytest.approx(0.95),
        ]

    def test_region_count_is_adaptive_and_bounded(self):
        assert regions_mod.pick_k(529) == 6
        assert regions_mod.pick_k(1961) == 8
        assert regions_mod.pick_k(50_000) == 12
        assert regions_mod.pick_k(5) == 1

    def test_kmeans_is_reproducible_and_finds_the_blobs(self):
        centers = np.array(
            [
                [0.8, 0, 0],
                [-0.8, 0, 0],
                [0, 0.8, 0],
                [0, -0.8, 0],
                [0, 0, 0.8],
                [0, 0, -0.8],
            ],
            dtype=np.float32,
        )
        x = _blobs(40, centers, 0.05, seed=3)
        labels_a, centers_a = regions_mod.kmeans(x, 6, seed=0)
        labels_b, centers_b = regions_mod.kmeans(x, 6, seed=0)
        assert np.array_equal(labels_a, labels_b) and np.allclose(centers_a, centers_b)
        # every blob lands in one region
        for blob in range(6):
            assert len(set(labels_a[blob * 40 : (blob + 1) * 40].tolist())) == 1
        assert len(set(labels_a.tolist())) == 6


class TestLabels:
    def test_style_tags_need_whitelist_enrichment_and_significance(self):
        # 40 tagged pictures in the region, 400 tagged overall. "monochrome"
        # sits on 12 of the region's pictures but only 15 elsewhere.
        region_ids = list(range(1, 41))
        tags_by_image = {i: {"monochrome"} for i in range(1, 13)}
        for i in range(1000, 1015):
            tags_by_image[i] = {"monochrome"}
        # "blurry" everywhere: common, not enriched
        for i in list(range(1, 41)) + list(range(1000, 1360)):
            tags_by_image.setdefault(i, set()).add("blurry")
        # a content tag is never a style label, however enriched
        for i in range(1, 30):
            tags_by_image[i].add("green_dress")
        tagged = set(range(1, 41)) | set(range(1000, 1360))
        labels = regions_mod.region_tag_labels(
            region_ids, tags_by_image=tags_by_image, tagged_ids=tagged, limit=2
        )
        assert [label["tag"] for label in labels] == ["monochrome"]
        mono = labels[0]
        assert mono["count"] == 12 and mono["tagged"] == 40
        assert mono["ratio"] > 3.0 and mono["p"] < 0.01 and mono["q"] < 0.01

    def test_a_style_that_is_a_third_of_the_map_can_still_label_its_region(self):
        # 40 of 40 monochrome in the region, 40 of 119 overall: ratio caps at
        # 2.975 (< 3) yet the region is plainly "the monochrome corner".
        region_ids = list(range(1, 41))
        tags_by_image = {i: {"monochrome"} for i in range(1, 41)}
        tagged = set(range(1, 120))
        labels = regions_mod.region_tag_labels(
            region_ids, tags_by_image=tags_by_image, tagged_ids=tagged
        )
        assert [label["tag"] for label in labels] == ["monochrome"]
        assert labels[0]["rate"] == pytest.approx(1.0) and labels[0]["ratio"] < 3.0

    def test_effect_size_alone_is_not_enough_without_significance(self):
        # 4 of 12 in the region vs 6 of 60 overall: ratio 3.33, count 4,
        # tagged 12 all clear the floors, but P(X >= 4) = 0.0119 > 0.01.
        region_ids = list(range(1, 13))
        tags_by_image = {i: {"monochrome"} for i in (1, 2, 3, 4, 13, 14)}
        tagged = set(range(1, 61))
        assert (
            regions_mod.region_tag_labels(
                region_ids, tags_by_image=tags_by_image, tagged_ids=tagged
            )
            == []
        )

    def test_correction_across_regions_removes_a_marginal_label(self):
        # Region A: 4 of 10 carry "sketch", 8 of 100 overall -> p = 0.00305.
        # Alone that is significant; beside four other admissible tests
        # (regions B-E, "comic" at the map's own rate) BH gives q = 0.0152.
        tags_by_image = {i: {"sketch"} for i in range(1, 5)}
        for i in (90, 91, 92, 93):
            tags_by_image[i] = {"sketch"}
        for i in (
            list(range(11, 15))
            + list(range(21, 25))
            + list(range(31, 35))
            + list(range(41, 45))
        ):
            tags_by_image.setdefault(i, set()).add("comic")
        for i in range(51, 75):
            tags_by_image.setdefault(i, set()).add("comic")
        tagged = set(range(1, 101))
        region_a = list(range(1, 11))
        others = [
            list(range(11, 21)),
            list(range(21, 31)),
            list(range(31, 41)),
            list(range(41, 51)),
        ]
        alone = regions_mod.tag_labels_for_regions(
            [region_a], tags_by_image=tags_by_image, tagged_ids=tagged
        )
        assert [label["tag"] for label in alone[0]] == ["sketch"]
        together = regions_mod.tag_labels_for_regions(
            [region_a, *others], tags_by_image=tags_by_image, tagged_ids=tagged
        )
        assert together == [[], [], [], [], []]

    def test_untagged_pictures_are_not_counted_as_lacking_the_tag(self):
        # Region of 40 with 12 tagged, all 12 monochrome; 28 untagged. Overall
        # 102 tagged pictures, 14 monochrome. Rate must use 12/12, not 12/40.
        region_ids = list(range(1, 41))
        tags_by_image = {i: {"monochrome"} for i in range(1, 13)}
        for i in range(500, 502):
            tags_by_image[i] = {"monochrome"}
        tagged = set(range(1, 13)) | set(range(500, 592))
        labels = regions_mod.region_tag_labels(
            region_ids, tags_by_image=tags_by_image, tagged_ids=tagged
        )
        assert labels and labels[0]["tag"] == "monochrome" and labels[0]["tagged"] == 12

    def test_too_few_tagged_pictures_gives_no_label(self):
        region_ids = list(range(1, 41))
        tags_by_image = {i: {"sketch"} for i in range(1, 4)}
        tagged = set(range(1, 4)) | set(range(500, 600))
        assert (
            regions_mod.region_tag_labels(
                region_ids, tags_by_image=tags_by_image, tagged_ids=tagged
            )
            == []
        )

    def test_artist_labels_use_the_confident_tier_only(self):
        region_ids = list(range(1, 21))
        predictions = {}
        for i in range(1, 8):
            predictions[i] = ("modare", 0.31)  # high tier
        for i in range(8, 12):
            predictions[i] = ("modare", 0.05)  # low tier: never counted
        for i in range(12, 15):
            predictions[i] = ("meion", 0.25)
        predictions[15] = ("undefined", 0.0)
        labels = regions_mod.region_artist_labels(
            region_ids, predictions_by_image=predictions, limit=2
        )
        assert [label["artist"] for label in labels] == ["modare", "meion"]
        assert labels[0]["count"] == 7 and labels[0]["high_total"] == 10
        assert labels[0]["share"] == pytest.approx(0.7)
        # below the share floor: no label
        few = {i: ("a", 0.3) for i in range(1, 3)}
        few.update({i: ("b", 0.3) for i in range(3, 12)})
        assert [
            label["artist"]
            for label in regions_mod.region_artist_labels(
                region_ids, predictions_by_image=few
            )
        ] == ["b"]

    def test_artist_labels_need_enough_confident_coverage(self):
        # 4 confident pictures, all one artist: too few to say anything
        four = {i: ("modare", 0.4) for i in range(1, 5)}
        assert (
            regions_mod.region_artist_labels(
                list(range(1, 21)), predictions_by_image=four
            )
            == []
        )
        # 5 confident pictures label a region of 100 (5%) but not one of 200
        five = {i: ("modare", 0.4) for i in range(1, 6)}
        labelled = regions_mod.region_artist_labels(
            list(range(1, 101)), predictions_by_image=five
        )
        assert [label["artist"] for label in labelled] == ["modare"]
        assert labelled[0]["high_total"] == 5 and labelled[0]["count"] == 5
        assert (
            regions_mod.region_artist_labels(
                list(range(1, 201)), predictions_by_image=five
            )
            == []
        )


class TestComputeRegions:
    def test_regions_cover_every_point_with_representatives(self):
        centers = np.array(
            [
                [0.8, 0, 0],
                [-0.8, 0, 0],
                [0, 0.8, 0],
                [0, -0.8, 0],
                [0, 0, 0.8],
                [0, 0, -0.8],
            ],
            dtype=np.float32,
        )
        xyz = _blobs(40, centers, 0.05, seed=5)
        ids = np.arange(1, 241)
        members = np.ones(240, dtype=np.int64)
        members[7] = 4
        features = _random_units(240, seed=6, dim=16)
        result = regions_mod.compute_regions(
            ids, xyz, members, features=features, seed=0
        )
        assert result["k"] == 6 and len(result["regions"]) == 6
        assert sum(region["size"] for region in result["regions"]) == 240
        assert sum(region["members_total"] for region in result["regions"]) == 243
        for region in result["regions"]:
            assert 1 <= len(region["representatives"]) <= 2
            assert all(rep in ids for rep in region["representatives"])
            assert len(region["center"]) == 3
        again = regions_mod.compute_regions(
            ids, xyz, members, features=features, seed=0
        )
        assert again == result


# ------------------------------------------------------------ service + route
def _make_images(test_db, tmp_path, count: int) -> list[int]:
    ids = []
    for index in range(count):
        path = tmp_path / f"img{index}.png"
        Image.new("RGB", (8, 8), (index * 7 % 255, 90, 120)).save(path)
        ids.append(
            test_db.add_image(
                path=str(path), filename=path.name, content_fingerprint=f"fp{index}"
            )
        )
    return ids


def _store_kaloscope(test_db, image_ids, vectors):
    from artist_identifier import kaloscope_style_vector_model_version

    version = kaloscope_style_vector_model_version(None)
    with test_db.get_db() as conn:
        for image_id, vector in zip(image_ids, vectors):
            blob, dim, dtype = pack_style_vector(vector)
            conn.execute(
                "INSERT OR REPLACE INTO image_style_vectors "
                "(image_id, space, model_version, content_fingerprint, dim, dtype, vector, updated_at) "
                "VALUES (?, 'kaloscope', ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))",
                (image_id, version, f"fp{image_ids.index(image_id)}", dim, dtype, blob),
            )


def _three_groups() -> np.ndarray:
    rng = np.random.default_rng(1)
    centers = rng.normal(size=(3, DIM))
    centers /= np.linalg.norm(centers, axis=1, keepdims=True)
    return np.concatenate(
        [center + 0.15 * rng.normal(size=(40, DIM)) for center in centers]
    ).astype(np.float32)


def artist_high_total(region) -> int:
    return region["artists"][0]["high_total"] if region["artists"] else 0


def _tag(test_db, image_id: int, tag: str) -> None:
    with test_db.get_db() as conn:
        conn.execute(
            "INSERT INTO tags (image_id, tag, confidence, source, category) VALUES (?, ?, 0.9, 'tagger', 'general')",
            (image_id, tag),
        )


class TestService:
    def test_regions_follow_the_points_map_and_read_tags_and_artists(
        self, test_db, tmp_path, monkeypatch
    ):
        monkeypatch.setattr(
            style_map_service.style_map_umap, "umap_available", lambda: False
        )
        # three tight groups of 40; group 0 is the monochrome / modare corner
        ids = _make_images(test_db, tmp_path, 120)
        _store_kaloscope(test_db, ids, _three_groups())
        for image_id in ids:
            _tag(test_db, image_id, "1girl")
        for image_id in ids[:40]:
            _tag(test_db, image_id, "monochrome")
        with test_db.get_db() as conn:
            for image_id in ids[:40]:
                conn.execute(
                    "INSERT INTO artist_predictions (image_id, artist, confidence, top_predictions) VALUES (?, 'modare', 0.4, '[]')",
                    (image_id,),
                )
        service = style_map_service.StyleMapService()
        assert service.regions("kaloscope")["status"] == "not_started"
        points = service.points("kaloscope")
        result = service.regions("kaloscope")
        assert result["status"] == "ok" and result["method"] == "pca"
        assert result["k"] == regions_mod.pick_k(len(points["points"]))
        assert sum(region["size"] for region in result["regions"]) == len(
            points["points"]
        )
        seen_ids = {
            rep for region in result["regions"] for rep in region["representatives"]
        }
        assert seen_ids <= {point[0] for point in points["points"]}
        corner = set(ids[:40])
        corner_regions = [
            region
            for region in result["regions"]
            if set(region["representatives"]) <= corner
            and region["size"] >= regions_mod.TAG_MIN_TAGGED
        ]
        assert corner_regions and all(
            [tag["tag"] for tag in region["tags"]] == ["monochrome"]
            and [artist["artist"] for artist in region["artists"]] == ["modare"]
            and artist_high_total(region) == region["size"]
            for region in corner_regions
        )
        assert all(
            region["tags"] == [] and region["artists"] == []
            for region in result["regions"]
            if region not in corner_regions
        )
        # the same map answers from the cache
        assert service.regions("kaloscope")["cached"] is True

    def test_new_tags_and_predictions_show_on_the_same_service(
        self, test_db, tmp_path, monkeypatch
    ):
        """The natural order is index first, WD14 / Style Finder later: the
        cached regions must notice the new labels (reviewer probe)."""
        monkeypatch.setattr(
            style_map_service.style_map_umap, "umap_available", lambda: False
        )
        ids = _make_images(test_db, tmp_path, 120)
        _store_kaloscope(test_db, ids, _three_groups())
        for image_id in ids:
            _tag(test_db, image_id, "1girl")
        service = style_map_service.StyleMapService()
        service.points("kaloscope")
        before = service.regions("kaloscope")
        assert all(
            region["tags"] == [] and region["artists"] == []
            for region in before["regions"]
        )
        assert service.regions("kaloscope")["cached"] is True
        for image_id in ids[:40]:
            _tag(test_db, image_id, "monochrome")
        after_tags = service.regions("kaloscope")
        assert after_tags["cached"] is False
        assert {tag["tag"] for r in after_tags["regions"] for tag in r["tags"]} == {
            "monochrome"
        }
        with test_db.get_db() as conn:
            for image_id in ids[:40]:
                conn.execute(
                    "INSERT OR REPLACE INTO artist_predictions (image_id, artist, confidence, top_predictions) VALUES (?, 'modare', 0.6, '[]')",
                    (image_id,),
                )
        after_artists = service.regions("kaloscope")
        assert after_artists["cached"] is False
        assert {
            a["artist"] for r in after_artists["regions"] for a in r["artists"]
        } == {"modare"}
        assert service.regions("kaloscope")["cached"] is True
        assert service.regions("kaloscope", refresh=True)["cached"] is False

    def test_regions_route(self, test_client, tmp_path, monkeypatch):
        from routers import style_map as style_map_router

        monkeypatch.setattr(
            style_map_service.style_map_umap, "umap_available", lambda: False
        )
        style_map_router.set_style_map_service(style_map_service.StyleMapService())
        try:
            ids = _make_images(test_client.test_db, tmp_path, 30)
            _store_kaloscope(test_client.test_db, ids, _random_units(30, seed=9))
            before = test_client.get(
                "/api/style-map/regions", params={"space": "kaloscope"}
            )
            assert (
                before.status_code == 200 and before.json()["status"] == "not_started"
            )
            test_client.get("/api/style-map/points", params={"space": "kaloscope"})
            response = test_client.get(
                "/api/style-map/regions", params={"space": "kaloscope"}
            )
            assert response.status_code == 200, response.text
            body = response.json()
            assert body["status"] == "ok" and len(body["regions"]) == body["k"]
            again = test_client.get(
                "/api/style-map/regions", params={"space": "kaloscope"}
            ).json()
            assert again["cached"] is True
            forced = test_client.get(
                "/api/style-map/regions",
                params={"space": "kaloscope", "refresh": "true"},
            ).json()
            assert forced["cached"] is False
            assert (
                test_client.get(
                    "/api/style-map/regions", params={"space": "dino"}
                ).status_code
                == 400
            )
        finally:
            style_map_router.set_style_map_service(None)


def test_whitelist_names_exist_in_both_language_packs():
    from pathlib import Path

    root = Path(__file__).resolve().parents[2] / "frontend" / "js" / "lang"
    zh = (root / "zh-CN.js").read_text(encoding="utf-8")
    en = (root / "en.js").read_text(encoding="utf-8")
    for tag in regions_mod.STYLE_TAG_WHITELIST:
        key = f"'stylemap.tag.{tag}'"
        assert key in zh and key in en, tag
    assert math.isfinite(regions_mod.hypergeom_tail(2, 10, 4, 5))
