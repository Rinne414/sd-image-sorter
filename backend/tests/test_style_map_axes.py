"""Style map axes (slice S4e): what the two ends of each axis stand for.

GET /api/style-map/axes answers for the map ``points`` last computed (PCA, or
the ready UMAP layout the page shows): per axis x/y/z the representative
pictures of both ends, WD14 general tags that separate the two ends (the
regions' BH + effect size rule), and ``weak`` when nothing separates them.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from services import style_map_axes as axes_mod
from services import style_map_service
from tests.test_style_map_regions import (
    _make_images,
    _random_units,
    _store_kaloscope,
    _tag,
    _three_groups,
)

N = 400


def _add_images(test_db, count: int) -> list[int]:
    test_db.add_images_batch(
        [
            {
                "path": f"/nowhere/img{index}.png",
                "filename": f"img{index}.png",
                "content_fingerprint": f"fp{index}",
            }
            for index in range(count)
        ]
    )
    with test_db.get_db() as conn:
        return [row[0] for row in conn.execute("SELECT id FROM images ORDER BY id")]


def _tag_all(test_db, image_ids, tag: str, category: str = "general") -> None:
    with test_db.get_db() as conn:
        conn.executemany(
            "INSERT INTO tags (image_id, tag, confidence, source, category) "
            "VALUES (?, ?, 0.9, 'tagger', ?)",
            [(int(i), tag, category) for i in image_ids],
        )


def _points(ids, xyz) -> list[list]:
    return [[i, float(x), float(y), float(z), 1] for i, (x, y, z) in zip(ids, xyz)]


def _scene(test_db, seed: int = 0):
    """N pictures on uniform random xyz, all tagged ``1girl``."""
    ids = _add_images(test_db, N)
    xyz = np.random.default_rng(seed).uniform(-1, 1, size=(N, 3))
    _tag_all(test_db, ids, "1girl")
    return ids, xyz


def _tags(axis_end: dict) -> list[str]:
    return [item["tag"] for item in axis_end["tags"]]


class TestAxes:
    def test_a_tag_only_at_the_high_end_of_x_labels_x_and_leaves_y_z_weak(
        self, test_db
    ):
        ids, xyz = _scene(test_db)
        high = np.argsort(xyz[:, 0])[-int(N * 0.25) :]
        _tag_all(test_db, np.array(ids)[high], "monochrome")
        result = axes_mod.axes_of_points(_points(ids, xyz))
        x, y, z = result["axes"]["x"], result["axes"]["y"], result["axes"]["z"]
        assert _tags(x["high"]) == ["monochrome"]
        assert x["low"]["tags"] == [] and x["weak"] is False
        assert x["strength"] > 0.5
        assert y["weak"] is True and z["weak"] is True
        assert y["high"]["tags"] == [] and z["low"]["tags"] == []
        assert "1girl" not in _tags(x["high"]) + _tags(x["low"])

    def test_a_tag_on_a_small_share_of_one_end_does_not_name_the_axis(self, test_db):
        ids, xyz = _scene(test_db, seed=11)
        order = np.argsort(xyz[:, 0])
        high = order[-int(N * 0.2) :]  # the outer fifth: 80 pictures
        _tag_all(test_db, np.array(ids)[high[:8]], "sepia")  # 10% vs 0%
        axes = axes_mod.axes_of_points(_points(ids, xyz))["axes"]
        assert axes["x"]["weak"] is True and axes["x"]["high"]["tags"] == []

    def test_the_tag_on_the_low_end_lands_on_low(self, test_db):
        ids, xyz = _scene(test_db, seed=3)
        _tag_all(test_db, np.array(ids)[np.argsort(xyz[:, 1])[: int(N * 0.25)]], "sketch")
        axes = axes_mod.axes_of_points(_points(ids, xyz))["axes"]
        assert _tags(axes["y"]["low"]) == ["sketch"]
        assert axes["y"]["high"]["tags"] == [] and axes["x"]["weak"] is True

    def test_content_tags_never_label_an_axis_however_big_the_difference(self, test_db):
        """Subject, clothing, rating, character and meta tags say what is
        drawn: an axis that only separates those has no style difference."""
        ids, xyz = _scene(test_db, seed=4)
        order = np.argsort(xyz[:, 0])
        top = np.array(ids)[order[-int(N * 0.25) :]]
        low = np.array(ids)[order[: int(N * 0.25)]]
        for tag in ("breasts", "nipples", "blush"):
            _tag_all(test_db, top, tag)
        for tag in ("skirt", "pleated_skirt", "from_above", "close-up"):
            _tag_all(test_db, low, tag)
        _tag_all(test_db, top, "explicit", "rating")
        _tag_all(test_db, top, "highres")
        _tag_all(test_db, low, "hatsune_miku", "character")
        result = axes_mod.axes_of_points(_points(ids, xyz))["axes"]
        assert all(result[name]["weak"] for name in "xyz")
        assert all(result[name][end]["tags"] == [] for name in "xyz" for end in ("low", "high"))

    def test_a_style_tag_beside_big_content_differences_is_the_only_label(self, test_db):
        ids, xyz = _scene(test_db, seed=12)
        order = np.argsort(xyz[:, 0])
        top = np.array(ids)[order[-int(N * 0.25) :]]
        _tag_all(test_db, top, "breasts")
        _tag_all(test_db, top, "watercolor_(medium)")
        _tag_all(test_db, np.array(ids)[order[: int(N * 0.25)]], "skirt")
        x = axes_mod.axes_of_points(_points(ids, xyz))["axes"]["x"]
        assert _tags(x["high"]) == ["watercolor_(medium)"] and x["low"]["tags"] == []

    def test_counting_samples_a_large_end_evenly_and_leaves_small_ones_whole(self):
        rows = np.arange(10_000)
        sample = axes_mod._sample(rows, cap=100)
        assert len(sample) == 100 and sample[0] == 0 and sample[-1] == 9_999
        assert np.all(np.diff(sample) > 0)
        small = np.arange(50)
        assert axes_mod._sample(small, cap=100) is small

    def test_an_axis_without_enough_tagged_pictures_is_weak(self, test_db):
        ids = _add_images(test_db, N)
        xyz = np.random.default_rng(5).uniform(-1, 1, size=(N, 3))
        # 5 tagged pictures only
        _tag_all(test_db, np.array(ids)[np.argsort(xyz[:, 0])[-5:]], "monochrome")
        axes = axes_mod.axes_of_points(_points(ids, xyz))["axes"]
        assert all(axes[name]["weak"] for name in "xyz")

    def test_ends_carry_three_representatives_from_the_outer_tenth_not_the_outlier(
        self, test_db
    ):
        ids, xyz = _scene(test_db, seed=6)
        xyz[0] = [100.0, 60.0, 60.0]  # a far outlier on the high end of x
        axes = axes_mod.axes_of_points(_points(ids, xyz))["axes"]
        high = axes["x"]["high"]["representatives"]
        low = axes["x"]["low"]["representatives"]
        assert len(high) == 3 and len(low) == 3
        assert ids[0] not in high
        rank = {
            image_id: i
            for i, image_id in enumerate(np.array(ids)[np.argsort(xyz[:, 0])])
        }
        assert all(rank[r] >= N - N // 10 for r in high)
        assert all(rank[r] < N // 10 for r in low)

    def test_merged_points_use_their_representative_and_members_do_not_weigh(
        self, test_db
    ):
        ids, xyz = _scene(test_db, seed=7)
        points = _points(ids, xyz)
        for point in points[:50]:
            point[4] = 9  # merged groups: still one point each
        assert axes_mod.axes_of_points(points)["axes"]["x"]["weak"] is True

    def test_the_same_map_gives_the_same_answer(self, test_db):
        ids, xyz = _scene(test_db, seed=8)
        _tag_all(test_db, np.array(ids)[np.argsort(xyz[:, 2])[-100:]], "lineart")
        points = _points(ids, xyz)
        assert axes_mod.axes_of_points(points) == axes_mod.axes_of_points(points)

    def test_tiny_maps_are_weak_not_an_error(self, test_db):
        ids = _add_images(test_db, 3)
        xyz = np.random.default_rng(1).uniform(-1, 1, size=(3, 3))
        axes = axes_mod.axes_of_points(_points(ids, xyz))["axes"]
        assert all(axes[name]["weak"] for name in "xyz")
        assert axes_mod.axes_of_points([])["axes"]["x"]["weak"] is True

def test_the_style_list_is_style_only_and_every_name_is_in_both_language_packs():
    from pathlib import Path

    from services import style_axis_tags

    assert len(style_axis_tags.STYLE_AXIS_TAGS) == len(style_axis_tags.STYLE_AXIS_TAG_SET)
    for composition in ("close-up", "from_above", "1girl", "solo", "breasts", "skirt", "highres"):
        assert composition not in style_axis_tags.STYLE_AXIS_TAG_SET
    root = Path(__file__).resolve().parents[2] / "frontend" / "js" / "lang"
    zh = (root / "zh-CN.js").read_text(encoding="utf-8")
    en = (root / "en.js").read_text(encoding="utf-8")
    for tag in style_axis_tags.STYLE_AXIS_TAGS:
        key = f"'stylemap.tag.{tag}'"
        assert key in zh and key in en, tag


def test_every_style_tag_is_in_a_shipped_tagger_vocabulary():
    """Checked against the selected_tags.csv files of the installed taggers
    (not shipped in the repo: skipped where they are absent)."""
    import csv

    from config import DATA_DIR
    from services import style_axis_tags

    base = Path(DATA_DIR) / "models" / "wd14-tagger"
    vocabularies = {}
    for model in ("wd-swinv2-tagger-v3", "pixai-tagger-v0.9"):
        path = base / model / "selected_tags.csv"
        if path.is_file():
            with path.open(encoding="utf-8", newline="") as handle:
                vocabularies[model] = {
                    row["name"] for row in csv.DictReader(handle) if row["category"] in ("0", "general")
                }
    if len(vocabularies) < 2:
        pytest.skip("tagger vocabularies are not installed")
    for tag in style_axis_tags.STYLE_AXIS_TAGS:
        assert any(tag in names for names in vocabularies.values()), tag


# ------------------------------------------------------------ service + route
def _service_with_map(test_db, tmp_path, monkeypatch, *, umap: bool = False):
    monkeypatch.setattr(
        style_map_service.style_map_umap, "umap_available", lambda: umap
    )
    ids = _make_images(test_db, tmp_path, 120)
    _store_kaloscope(test_db, ids, _three_groups())
    for image_id in ids:
        _tag(test_db, image_id, "1girl")
    for image_id in ids[:40]:
        _tag(test_db, image_id, "monochrome")
    service = style_map_service.StyleMapService()
    return service, ids


class TestService:
    def test_axes_follow_the_points_map_by_map_id_and_cache(
        self, test_db, tmp_path, monkeypatch
    ):
        service, _ids = _service_with_map(test_db, tmp_path, monkeypatch)
        assert service.axes("kaloscope")["status"] == "not_started"
        points = service.points("kaloscope")
        result = service.axes("kaloscope", map_id=points["map_id"])
        assert result["status"] == "ok" and result["layout"] == "pca"
        assert set(result["axes"]) == {"x", "y", "z"}
        assert result["cached"] is False
        assert service.axes("kaloscope", map_id=points["map_id"])["cached"] is True

    def test_unknown_evicted_or_foreign_map_ids_are_not_started(
        self, test_db, tmp_path, monkeypatch
    ):
        service, _ids = _service_with_map(test_db, tmp_path, monkeypatch)
        map_id = service.points("kaloscope")["map_id"]
        assert service.axes("kaloscope", map_id="0" * 32)["status"] == "not_started"
        # the same handle named for another space is another map
        assert service.axes("clip", map_id=map_id)["status"] == "not_started"
        with monkeypatch.context() as patch:
            patch.setattr(
                "services.style_map_colors.get_current_library_id", lambda: "other-lib"
            )
            assert service.axes("kaloscope", map_id=map_id)["status"] == "not_started"
        service.clear_cache()
        assert service.axes("kaloscope", map_id=map_id)["status"] == "not_started"

    def test_new_tags_invalidate_the_cached_axes(self, test_db, tmp_path, monkeypatch):
        service, ids = _service_with_map(test_db, tmp_path, monkeypatch)
        map_id = service.points("kaloscope")["map_id"]
        service.axes("kaloscope", map_id=map_id)
        assert service.axes("kaloscope", map_id=map_id)["cached"] is True
        _tag(test_db, ids[-1], "lineart")
        assert service.axes("kaloscope", map_id=map_id)["cached"] is False

    def test_umap_layout_not_ready_is_not_a_pca_answer(
        self, test_db, tmp_path, monkeypatch
    ):
        service, _ids = _service_with_map(test_db, tmp_path, monkeypatch)
        map_id = service.points("kaloscope")["map_id"]
        result = service.axes("kaloscope", map_id=map_id, layout="umap")
        assert result["status"] == "layout_not_ready" and result["layout"] == "umap"

    def test_umap_layout_uses_the_displayed_umap_coordinates(
        self, test_db, tmp_path, monkeypatch
    ):
        service, ids = _service_with_map(test_db, tmp_path, monkeypatch, umap=True)
        points = service.points("kaloscope")
        key = service._handles[points["map_id"]]
        inputs = service._inputs[key]
        flipped = np.array(
            [[-p[1], p[2], p[3]] for p in points["points"]], dtype=np.float32
        )
        service._remember_layout(
            service._layout_key(key), inputs.rep_ids, flipped, "memory", 0.0
        )
        pca = service.axes("kaloscope", map_id=points["map_id"], layout="pca")
        umap = service.axes("kaloscope", map_id=points["map_id"], layout="umap")
        assert umap["status"] == "ok" and umap["layout"] == "umap"
        assert (
            pca["axes"]["x"]["high"]["representatives"]
            == umap["axes"]["x"]["low"]["representatives"]
        )
        assert (
            pca["axes"]["x"]["low"]["representatives"]
            == umap["axes"]["x"]["high"]["representatives"]
        )

    def test_axes_route_and_its_400s(self, test_client, tmp_path, monkeypatch):
        from routers import style_map as style_map_router

        monkeypatch.setattr(
            style_map_service.style_map_umap, "umap_available", lambda: False
        )
        style_map_router.set_style_map_service(style_map_service.StyleMapService())
        try:
            ids = _make_images(test_client.test_db, tmp_path, 30)
            _store_kaloscope(test_client.test_db, ids, _random_units(30, seed=9))
            idle = test_client.get("/api/style-map/axes", params={"space": "kaloscope"})
            assert idle.status_code == 200 and idle.json()["status"] == "not_started"
            map_id = test_client.get(
                "/api/style-map/points", params={"space": "kaloscope"}
            ).json()["map_id"]
            ok = test_client.get(
                "/api/style-map/axes",
                params={"space": "kaloscope", "map_id": map_id, "layout": "pca"},
            )
            assert ok.status_code == 200, ok.text
            assert ok.json()["status"] == "ok"
            for params in (
                {"space": "nope"},
                {"space": "kaloscope", "map_id": "xyz"},
                {"space": "kaloscope", "layout": "tsne"},
            ):
                assert (
                    test_client.get("/api/style-map/axes", params=params).status_code
                    == 400
                ), params
        finally:
            style_map_router.set_style_map_service(None)


def test_pictures_without_any_tag_are_not_in_the_tagged_denominator(test_db):
    """Half the pictures have no tag row at all: the rate of a tag is taken over
    the TAGGED pictures (about 1.0 here), not over every picture (about 0.5)."""
    n = 1000
    ids = np.array(_add_images(test_db, n))
    xyz = np.random.default_rng(1).uniform(-1, 1, size=(n, 3))
    tagged_ids = ids[: n // 2]
    _tag_all(test_db, tagged_ids, "1girl")
    top_y = ids[np.argsort(xyz[:, 1])[-300:]]
    _tag_all(test_db, np.intersect1d(top_y, tagged_ids), "monochrome")
    axes = axes_mod.axes_of_points(_points(ids, xyz))["axes"]
    assert not axes["y"]["weak"] and _tags(axes["y"]["high"]) == ["monochrome"]
    assert axes["y"]["high"]["tags"][0]["rate"] > 0.9
    assert axes["y"]["high"]["tagged"] < axes["y"]["high"]["size"]
