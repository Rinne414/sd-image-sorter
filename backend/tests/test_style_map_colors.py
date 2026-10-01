"""Style map point colours (slice S4a): GET /api/style-map/colors.

Pure rules on synthetic values (top 12 categories plus "other", scale range,
no data = null, folder labels), then the service against the DB: the answer
covers exactly the representatives of the cached map (filter token, model
settings, merged near-duplicates), artists marked ``undefined`` are no
data, and the route.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from exceptions import ValidationError
from services import style_map_colors as colors_mod
from services import style_map_service
from tests.test_style_map_points import (
    _make_images,
    _official_version,
    _random_units,
    _service,
    _store_kaloscope,
    _unit,
)


# ------------------------------------------------------------------ pure
class TestCategoryRules:
    def test_largest_twelve_categories_then_other(self):
        ids = list(range(1, 200))
        raw = {}
        # 14 categories: "c01" has 1 picture, "c02" 2, ... "c14" 14.
        cursor = 0
        for size in range(1, 15):
            for _ in range(size):
                raw[ids[cursor]] = f"c{size:02d}"
                cursor += 1
        body = colors_mod.category_colors(ids, raw, by="generator")

        assert body["kind"] == "category"
        keys = [entry["key"] for entry in body["legend"]]
        assert keys[:12] == [f"c{size:02d}" for size in range(14, 2, -1)]
        assert keys[12] == colors_mod.OTHER_KEY and len(keys) == 13
        assert body["legend"][12]["count"] == 1 + 2
        assert body["legend"][0]["count"] == 14
        # every picture of a folded category points at the "other" entry
        folded = [ids[i] for i in range(cursor) if raw[ids[i]] in ("c01", "c02")]
        assert all(body["values"][ids.index(i)] == 12 for i in folded)
        assert body["values"][ids.index(ids[cursor - 1])] == 0  # a c14 picture
        # pictures without a value are null
        assert body["values"][ids.index(ids[-1])] is None

    def test_no_other_entry_when_everything_fits(self):
        ids = [1, 2, 3, 4]
        body = colors_mod.category_colors(
            ids, {1: "nai", 2: "nai", 3: "comfyui"}, by="generator"
        )
        assert [e["key"] for e in body["legend"]] == ["nai", "comfyui"]
        assert body["values"] == [0, 0, 1, None]
        assert body["range"] is None

    def test_ties_are_ordered_by_key_and_the_limit_is_honoured(self):
        ids = list(range(1, 7))
        raw = {1: "b", 2: "a", 3: "c", 4: "d", 5: "e", 6: "f"}
        body = colors_mod.category_colors(ids, raw, by="generator", limit=2)
        assert [e["key"] for e in body["legend"]] == ["a", "b", colors_mod.OTHER_KEY]
        assert body["legend"][2]["count"] == 4
        assert body["values"] == [1, 0, 2, 2, 2, 2]

    def test_folder_label_is_the_last_segment_and_the_key_the_full_path(self):
        body = colors_mod.category_colors(
            [1, 2], {1: "L:/pics/Set A", 2: "L:/pics/Set A"}, by="folder"
        )
        assert body["legend"] == [
            {"key": "L:/pics/Set A", "label": "Set A", "count": 2}
        ]

    @pytest.mark.parametrize(
        "path, folder, label",
        [
            (r"L:\Pictures\AAA\SFW\00001.png", "L:/Pictures/AAA/SFW", "SFW"),
            ("/home/u/out/img.png", "/home/u/out", "out"),
            ("C:/img.png", "C:", "C:"),
            ("img.png", None, None),
            ("", None, None),
        ],
    )
    def test_folder_of_and_label(self, path, folder, label):
        assert colors_mod.folder_of(path) == folder
        if folder is not None:
            assert colors_mod.folder_label(folder) == label


class TestScaleRules:
    def test_range_covers_the_present_numbers_only(self):
        ids = [1, 2, 3, 4, 5]
        raw = {1: 5.5, 2: 7.25, 4: 3.0, 5: 6.12345}
        body = colors_mod.scale_colors(ids, raw)
        assert body["kind"] == "scale"
        assert body["values"] == [5.5, 7.25, None, 3.0, 6.123]
        assert body["range"] == [3.0, 7.25]
        assert body["legend"] == []

    def test_nan_and_garbage_are_no_data_and_an_empty_scale_has_no_range(self):
        body = colors_mod.scale_colors([1, 2, 3], {1: math.nan, 2: "x"})
        assert body["values"] == [None, None, None]
        assert body["range"] is None

    def test_unknown_field_is_refused(self):
        with pytest.raises(ValidationError):
            colors_mod.require_color_field("rating")
        assert colors_mod.require_color_field(" Generator ") == "generator"


# --------------------------------------------------------------- service
def _set(test_db, sql, params=()):
    with test_db.get_db() as conn:
        conn.execute(sql, params)


def _predict(test_db, image_id, artist, confidence=0.5):
    _set(
        test_db,
        "INSERT OR REPLACE INTO artist_predictions (image_id, artist, confidence) VALUES (?, ?, ?)",
        (image_id, artist, confidence),
    )


@pytest.fixture
def no_umap(monkeypatch):
    monkeypatch.setattr(
        style_map_service.style_map_umap, "umap_available", lambda: False
    )


class TestService:
    def test_colors_cover_the_cached_map_in_point_order(
        self, test_db, tmp_path, no_umap
    ):
        ids = _make_images(test_db, tmp_path, 6)
        for image_id, generator in zip(
            ids, ["nai", "nai", "forge", None, "webui", "nai"]
        ):
            _set(
                test_db,
                "UPDATE images SET generator = ? WHERE id = ?",
                (generator, image_id),
            )
        _store_kaloscope(test_db, ids, _random_units(6, seed=3))
        service = _service()

        before = service.colors_json("kaloscope", by="generator")
        assert b'"status":"not_started"' in before and b'"ids":[]' in before

        points = service.points("kaloscope")
        body = service.colors("kaloscope", by="generator")

        assert body["status"] == "ok" and body["by"] == "generator"
        assert body["kind"] == "category"
        assert body["ids"] == [point[0] for point in points["points"]]
        assert body["model_version"] == _official_version()
        legend = {entry["key"]: entry for entry in body["legend"]}
        assert legend["nai"]["count"] == 3 and legend["forge"]["count"] == 1
        assert [entry["key"] for entry in body["legend"]][0] == "nai"
        by_id = dict(zip(body["ids"], body["values"]))
        nai_index = [e["key"] for e in body["legend"]].index("nai")
        assert by_id[ids[0]] == by_id[ids[1]] == by_id[ids[5]] == nai_index
        assert by_id[ids[3]] is None
        assert body["missing"] == 1

    def test_colors_follow_the_gallery_filter_token(self, test_db, tmp_path, no_umap):
        from services.image_service import ImageService

        ids = _make_images(test_db, tmp_path, 6)
        for image_id in (ids[1], ids[3], ids[4]):
            _set(
                test_db, "UPDATE images SET generator = 'nai' WHERE id = ?", (image_id,)
            )
        _store_kaloscope(test_db, ids, _random_units(6, seed=13))
        token = ImageService().create_selection_token(generators=["nai"])[
            "selection_token"
        ]
        service = _service()
        service.points("kaloscope")
        service.points("kaloscope", selection_token=token)

        whole = service.colors("kaloscope", by="generator")
        scoped = service.colors("kaloscope", selection_token=token, by="generator")

        assert sorted(whole["ids"]) == sorted(ids)
        assert sorted(scoped["ids"]) == sorted([ids[1], ids[3], ids[4]])
        assert scoped["legend"] == [{"key": "nai", "label": "nai", "count": 3}]

    def test_undefined_artist_is_no_data_and_scores_are_a_scale(
        self, test_db, tmp_path, no_umap
    ):
        ids = _make_images(test_db, tmp_path, 4)
        _store_kaloscope(test_db, ids, _random_units(4, seed=5))
        _predict(test_db, ids[0], "modare", 0.6)
        _predict(test_db, ids[1], "undefined", 0.05)
        _predict(test_db, ids[2], "", 0.3)
        _set(test_db, "UPDATE images SET aesthetic_score = 6.5 WHERE id = ?", (ids[0],))
        _set(
            test_db, "UPDATE images SET aesthetic_score = 4.25 WHERE id = ?", (ids[2],)
        )
        _set(test_db, "UPDATE images SET aesthetic_waifu = 7.0 WHERE id = ?", (ids[3],))
        service = _service()
        service.points("kaloscope")

        artists = service.colors("kaloscope", by="artist")
        by_id = dict(zip(artists["ids"], artists["values"]))
        assert artists["legend"] == [{"key": "modare", "label": "modare", "count": 1}]
        assert by_id[ids[0]] == 0
        assert by_id[ids[1]] is None and by_id[ids[2]] is None and by_id[ids[3]] is None
        assert artists["missing"] == 3

        laion = service.colors("kaloscope", by="aesthetic_score")
        assert laion["kind"] == "scale" and laion["legend"] == []
        assert dict(zip(laion["ids"], laion["values"])) == {
            ids[0]: 6.5,
            ids[1]: None,
            ids[2]: 4.25,
            ids[3]: None,
        }
        assert laion["range"] == [4.25, 6.5]

        waifu = service.colors("kaloscope", by="aesthetic_waifu")
        assert waifu["range"] == [7.0, 7.0] and waifu["missing"] == 3
        anime = service.colors("kaloscope", by="aesthetic_anime")
        assert anime["range"] is None and anime["missing"] == 4

    def test_folders_use_the_image_path(self, test_db, tmp_path, no_umap):
        ids = _make_images(test_db, tmp_path, 3)
        _store_kaloscope(test_db, ids, _random_units(3, seed=6))
        _set(
            test_db,
            "UPDATE images SET path = ? WHERE id = ?",
            (r"D:\out\set b\a.png", ids[2]),
        )
        service = _service()
        service.points("kaloscope")

        body = service.colors("kaloscope", by="folder")

        own = str(tmp_path).replace("\\", "/")
        assert body["legend"][0] == {"key": own, "label": tmp_path.name, "count": 2}
        assert body["legend"][1] == {
            "key": "D:/out/set b",
            "label": "set b",
            "count": 1,
        }

    def test_a_merged_group_shows_its_representatives_value(
        self, test_db, tmp_path, no_umap
    ):
        ids = _make_images(test_db, tmp_path, 3)
        vectors = _random_units(3, seed=21)
        vectors[2] = _unit(
            vectors[0] + 0.01 * np.random.default_rng(1).normal(size=vectors.shape[1])
        )
        _store_kaloscope(test_db, ids, vectors)
        _set(test_db, "UPDATE images SET generator = 'nai' WHERE id = ?", (ids[0],))
        _set(test_db, "UPDATE images SET generator = 'forge' WHERE id = ?", (ids[2],))
        _set(test_db, "UPDATE images SET generator = 'webui' WHERE id = ?", (ids[1],))
        service = _service()
        points = service.points("kaloscope")
        assert points["merged_away"] == 1

        body = service.colors("kaloscope", by="generator")

        assert sorted(body["ids"]) == sorted(
            [ids[0], ids[1]]
        )  # ids[2] folded into ids[0]
        keys = [entry["key"] for entry in body["legend"]]
        assert "forge" not in keys  # the folded picture's own value is not shown
        by_id = dict(zip(body["ids"], body["values"]))
        assert keys[by_id[ids[0]]] == "nai"
        assert sum(entry["count"] for entry in body["legend"]) == 2

    def test_colors_follow_the_users_local_weights(self, test_db, tmp_path, no_umap):
        from artist_identifier import kaloscope_style_vector_model_version

        local = tmp_path / "my-kaloscope.pth"
        local.write_bytes(b"local weights")
        ids = _make_images(test_db, tmp_path, 5)
        _store_kaloscope(
            test_db,
            ids[:3],
            _random_units(3, seed=1),
            version=kaloscope_style_vector_model_version(str(local)),
        )
        _store_kaloscope(test_db, ids[3:], _random_units(2, seed=2))
        service = _service()
        service.points("kaloscope")
        service.points("kaloscope", model_path=str(local))

        official = service.colors("kaloscope", by="generator")
        mine = service.colors("kaloscope", by="generator", model_path=str(local))

        assert sorted(official["ids"]) == sorted(ids[3:])
        assert sorted(mine["ids"]) == sorted(ids[:3])

    def test_values_are_read_fresh_without_touching_the_points_cache(
        self, test_db, tmp_path, no_umap
    ):
        ids = _make_images(test_db, tmp_path, 3)
        _store_kaloscope(test_db, ids, _random_units(3, seed=8))
        service = _service()
        service.points("kaloscope")
        assert service.colors("kaloscope", by="artist")["missing"] == 3

        _predict(test_db, ids[1], "wlop", 0.9)
        body = service.colors("kaloscope", by="artist")
        assert body["legend"][0]["key"] == "wlop" and body["missing"] == 2
        assert service.points("kaloscope")["cached"] is True

    def test_map_id_names_the_cached_map_without_the_filter_query(
        self, test_db, tmp_path, no_umap, monkeypatch
    ):
        """Round 2: the handle in a points answer locates that map directly;
        an unknown handle (another process, evicted) is not_started."""
        ids = _make_images(test_db, tmp_path, 4)
        _store_kaloscope(test_db, ids, _random_units(4, seed=31))
        service = _service()
        points = service.points("kaloscope")
        handle = points["map_id"]
        assert len(handle) == colors_mod.MAP_ID_LENGTH and int(handle, 16) >= 0
        assert service.points("kaloscope")["map_id"] == handle  # stable per map

        def no_filter_query(*_args, **_kwargs):
            raise AssertionError("map_id must not re-run the filter query")

        monkeypatch.setattr(service, "_filtered_ids", no_filter_query)
        body = service.colors("kaloscope", by="generator", map_id=handle)
        assert body["status"] == "ok"
        assert body["ids"] == [point[0] for point in points["points"]]
        regions = service.regions("kaloscope", map_id=handle)
        assert regions["status"] == "ok"
        assert sum(region["size"] for region in regions["regions"]) == 4
        unknown = service.colors("kaloscope", by="generator", map_id="f" * 32)
        assert unknown["status"] == "not_started" and unknown["ids"] == []
        assert service.regions("kaloscope", map_id="f" * 32)["status"] == "not_started"
        # the handle names one space: the clip map is a different map
        assert (
            service.colors("clip", by="generator", map_id=handle)["status"]
            == "not_started"
        )

    def test_map_id_follows_the_map_when_the_filter_set_changes(
        self, test_db, tmp_path, no_umap
    ):
        """New pictures change the key (and the handle) of the filter; the old
        handle keeps answering for the map the page still shows, until it is
        evicted, and never loops the page back into a recompute."""
        ids = _make_images(test_db, tmp_path, 3)
        _store_kaloscope(test_db, ids, _random_units(3, seed=32))
        service = _service()
        old = service.points("kaloscope")
        more = _make_images(test_db, tmp_path, 2, prefix="late")
        _store_kaloscope(test_db, more, _random_units(2, seed=33))
        new = service.points("kaloscope")
        assert new["map_id"] != old["map_id"]
        stale = service.colors("kaloscope", by="generator", map_id=old["map_id"])
        assert stale["status"] == "ok" and sorted(stale["ids"]) == sorted(ids)
        fresh = service.colors("kaloscope", by="generator", map_id=new["map_id"])
        assert sorted(fresh["ids"]) == sorted(ids + more)

    def test_evicted_handle_is_not_started(
        self, test_db, tmp_path, no_umap, monkeypatch
    ):
        monkeypatch.setattr(style_map_service, "_CACHE_ENTRIES", 1)
        ids = _make_images(test_db, tmp_path, 2)
        _store_kaloscope(test_db, ids, _random_units(2, seed=34))
        _set(test_db, "UPDATE images SET generator = 'nai' WHERE id = ?", (ids[0],))
        service = _service()
        from services.image_service import ImageService

        token = ImageService().create_selection_token(generators=["nai"])[
            "selection_token"
        ]
        first = service.points("kaloscope")["map_id"]
        service.points("kaloscope", selection_token=token)  # evicts the first map
        assert len(service._handles) == len(service._cache) == 1
        assert first not in service._handles
        assert (
            service.colors("kaloscope", by="generator", map_id=first)["status"]
            == "not_started"
        )

    def test_map_id_never_reads_across_libraries(self, test_client, tmp_path, no_umap):
        """A handle minted in one library answers nothing under another
        library's header (X-SD-Library-Id), even though the map is cached."""
        from library_context import reset_current_library_id, set_current_library_id
        from routers import style_map as style_map_router

        db = test_client.test_db
        style_map_router.set_style_map_service(style_map_service.StyleMapService())
        try:
            main_ids = _make_images(db, tmp_path, 3, prefix="main")
            token = set_current_library_id("libB")
            try:
                b_ids = _make_images(db, tmp_path, 2, prefix="b")
            finally:
                reset_current_library_id(token)
            _store_kaloscope(db, main_ids + b_ids, _random_units(5, seed=35))
            main_map = test_client.get(
                "/api/style-map/points", params={"space": "kaloscope"}
            ).json()
            assert sorted(p[0] for p in main_map["points"]) == sorted(main_ids)
            handle = main_map["map_id"]
            other = {"X-SD-Library-Id": "libB"}
            for route, extra in (("colors", {"by": "generator"}), ("regions", {})):
                cross = test_client.get(
                    f"/api/style-map/{route}",
                    params={"space": "kaloscope", "map_id": handle, **extra},
                    headers=other,
                ).json()
                assert cross["status"] == "not_started", (route, cross)
                own = test_client.get(
                    f"/api/style-map/{route}",
                    params={"space": "kaloscope", "map_id": handle, **extra},
                ).json()
                assert own["status"] == "ok", (route, own)
            assert sorted(
                test_client.get(
                    "/api/style-map/colors",
                    params={"space": "kaloscope", "map_id": handle, "by": "generator"},
                ).json()["ids"]
            ) == sorted(main_ids)
        finally:
            style_map_router.set_style_map_service(None)

    def test_unknown_field_and_space_are_400(self, test_db):
        from fastapi import HTTPException

        service = _service()
        with pytest.raises(ValidationError):
            service.colors_json("kaloscope", by="rating")
        with pytest.raises(HTTPException) as info:
            service.colors_json("kaloscope", by="generator", selection_token="bad!!")
        assert info.value.status_code == 400

    def test_route(self, test_client, tmp_path, no_umap):
        from routers import style_map as style_map_router

        style_map_router.set_style_map_service(style_map_service.StyleMapService())
        try:
            ids = _make_images(test_client.test_db, tmp_path, 4)
            _store_kaloscope(test_client.test_db, ids, _random_units(4, seed=9))
            idle = test_client.get(
                "/api/style-map/colors",
                params={"space": "kaloscope", "by": "generator"},
            )
            assert idle.status_code == 200 and idle.json()["status"] == "not_started"
            test_client.get("/api/style-map/points", params={"space": "kaloscope"})
            response = test_client.get(
                "/api/style-map/colors",
                params={"space": "kaloscope", "by": "generator"},
            )
            assert response.status_code == 200, response.text
            body = response.json()
            assert body["status"] == "ok" and len(body["ids"]) == 4
            assert body["legend"][0]["key"] == "unknown"
            scale = test_client.get(
                "/api/style-map/colors",
                params={"space": "kaloscope", "by": "aesthetic_anime"},
            ).json()
            assert scale["kind"] == "scale" and scale["range"] is None
            for bad in ({"by": "rating"}, {"space": "csd"}):
                assert (
                    test_client.get(
                        "/api/style-map/colors", params={"space": "kaloscope", **bad}
                    ).status_code
                    == 400
                )
        finally:
            style_map_router.set_style_map_service(None)
