"""Filter the Gallery by the anime aesthetic scores.

Aesthetic scoring can also compute the deepghs anime grade (masterpiece ...
worst) and the Waifu Scorer V3 score (0-10) when those optional models are
installed. Until 2026-09-30 both could only sort the Gallery, so "hide the
low/worst pictures" or "move them out" was impossible. The filter keys are
``anime_grades`` (any of the seven grades) and ``min_waifu`` / ``max_waifu``.
Pictures without that score never match a set filter, like the LAION range.

Every consumer of the Gallery filter picks these keys up through
test_filter_scope_parity, which derives its key list from SelectionIdsRequest.
"""

from __future__ import annotations

import pytest
from PIL import Image


def _add(db, filename, grade=None, waifu=None, path_root="/lib"):
    image_id = db.add_image(
        path=f"{path_root}/{filename}",
        filename=filename,
        generator="comfyui",
        metadata_json="{}",
    )
    with db.get_db() as conn:
        conn.execute(
            "UPDATE images SET aesthetic_anime_grade = ?, aesthetic_waifu = ? WHERE id = ?",
            (grade, waifu, image_id),
        )
        conn.commit()
    return image_id


@pytest.fixture
def graded(test_db):
    return {
        "master": _add(test_db, "master.png", grade="masterpiece", waifu=9.1),
        "best": _add(test_db, "best.png", grade="best", waifu=7.4),
        "normal": _add(test_db, "normal.png", grade="normal", waifu=4.0),
        "worst": _add(test_db, "worst.png", grade="worst", waifu=0.5),
        "unscored": _add(test_db, "unscored.png"),
    }


def _names(db, **filters):
    page = db.get_images_paginated(limit=50, **filters)
    return sorted(image["filename"] for image in page["images"])


def test_grade_filter_keeps_any_of_the_picked_grades(test_db, graded):
    assert _names(test_db, anime_grades=["masterpiece", "best"]) == [
        "best.png",
        "master.png",
    ]
    assert test_db.get_filtered_image_count(anime_grades=["masterpiece", "best"]) == 2


def test_grade_filter_finds_the_low_end_to_move_out(test_db, graded):
    assert _names(test_db, anime_grades=["low", "worst"]) == ["worst.png"]


def test_waifu_range_needs_a_waifu_score(test_db, graded):
    assert _names(test_db, min_waifu=7.0) == ["best.png", "master.png"]
    assert _names(test_db, max_waifu=4.0) == ["normal.png", "worst.png"]
    # 0 is still a bound: the unscored picture does not match.
    assert test_db.get_filtered_image_count(min_waifu=0) == 4


def test_grade_and_waifu_filters_combine(test_db, graded):
    assert _names(test_db, anime_grades=["best", "normal"], min_waifu=5.0) == [
        "best.png"
    ]


def test_no_anime_filter_keeps_every_picture(test_db, graded):
    assert test_db.get_filtered_image_count(anime_grades=[], min_waifu=None) == 5


def test_selection_ids_follow_the_anime_filters(test_db, graded):
    ids = test_db.get_filtered_image_ids(anime_grades=["worst"], max_waifu=1.0)
    assert ids == [graded["worst"]]


# ---- API boundary --------------------------------------------------------


def test_listing_route_filters_by_grade_and_waifu(test_client, tmp_path):
    # The listing drops rows whose files are missing, so these are real files.
    db = test_client.test_db
    for name in ("keep.png", "drop.png"):
        Image.new("RGB", (16, 16), "white").save(tmp_path / name)
    keep = _add(db, "keep.png", grade="great", waifu=8.0, path_root=str(tmp_path))
    _add(db, "drop.png", grade="low", waifu=8.0, path_root=str(tmp_path))

    resp = test_client.get("/api/images?anime_grades=great,best&min_waifu=6&limit=50")

    assert resp.status_code == 200, resp.text
    assert [image["id"] for image in resp.json()["images"]] == [keep]


def test_count_route_counts_with_the_anime_filters(test_client):
    db = test_client.test_db
    _add(db, "a.png", grade="best", waifu=6.5)
    _add(db, "b.png", grade="best", waifu=3.0)
    _add(db, "c.png", grade="normal", waifu=6.5)

    resp = test_client.get("/api/images/count?anime_grades=best&min_waifu=5")

    assert resp.status_code == 200, resp.text
    assert resp.json()["total"] == 1


def test_selection_token_counts_with_the_anime_filters(test_client):
    db = test_client.test_db
    _add(db, "a.png", grade="masterpiece", waifu=9.0)
    _add(db, "b.png", grade="good", waifu=9.0)

    resp = test_client.post(
        "/api/images/selection-token",
        json={"animeGrades": ["masterpiece"], "minWaifu": 8.5},
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["total_estimate"] == 1


@pytest.mark.parametrize(
    "query",
    ["anime_grades=superb", "min_waifu=11", "max_waifu=-1"],
)
def test_listing_route_rejects_values_that_cannot_match(test_client, query):
    resp = test_client.get(f"/api/images?{query}&limit=5")
    assert resp.status_code in (400, 422), resp.text


def test_selection_token_rejects_an_unknown_grade(test_client):
    resp = test_client.post(
        "/api/images/selection-token", json={"animeGrades": ["superb"]}
    )
    assert resp.status_code == 400, resp.text
    assert "superb" in resp.json()["error"]


def test_grade_names_match_the_anime_aesthetic_model():
    import anime_aesthetic
    from constants import ANIME_AESTHETIC_GRADES

    assert ANIME_AESTHETIC_GRADES == anime_aesthetic.LABELS


def test_a_move_with_the_waifu_range_backwards_is_refused(tmp_path):
    from pydantic import ValidationError

    from services.sorting_models import BatchMoveRequest

    with pytest.raises(ValidationError, match="max_waifu cannot be less than min_waifu"):
        BatchMoveRequest(destination_folder=str(tmp_path), min_waifu=8, max_waifu=3)
