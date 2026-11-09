"""The gallery's "Not tagged yet" filter (``untagged`` / ``tagged_at IS NULL``).

The Professional look's Quick views list "未打标签 / Not tagged yet" with a live
count. It first used the no-caption filter, which a WD14 run never changes
(tagging writes tag rows and ``tagged_at``, not ``ai_caption``), so a fully
tagged library still counted every picture as untagged. The filter uses the
definition the tagger's "untagged only" run and ``get_untagged_image_ids`` use.
"""

from __future__ import annotations


def _add(db, filename: str) -> int:
    return int(
        db.add_image(
            path=f"/lib/{filename}",
            filename=filename,
            generator="comfyui",
            metadata_json="{}",
        )
    )


def _tag(db, image_id: int, tags=({"tag": "1girl", "confidence": 0.9},)) -> None:
    db.add_tags(image_id, list(tags))


def _library(db) -> dict:
    tagged = _add(db, "tagged.png")
    _tag(db, tagged)
    zero_tags = _add(db, "tagged-zero.png")
    _tag(db, zero_tags, tags=())  # a run that matched nothing still counts as tagged
    fresh = _add(db, "fresh.png")
    captioned = _add(db, "captioned.png")
    with db.get_db() as conn:  # a caption is not a tag run
        conn.execute(
            "UPDATE images SET ai_caption = ? WHERE id = ?", ("a cat", captioned)
        )
    return {"tagged": tagged, "zero": zero_tags, "fresh": fresh, "captioned": captioned}


def test_untagged_matches_pictures_no_tag_run_has_touched(test_db):
    ids = _library(test_db)

    assert test_db.get_filtered_image_count(untagged=True) == 2
    page = test_db.get_images_paginated(untagged=True, limit=50)
    assert sorted(i["id"] for i in page["images"]) == sorted(
        [ids["fresh"], ids["captioned"]]
    )
    assert sorted(test_db.get_untagged_image_ids()) == sorted(
        [ids["fresh"], ids["captioned"]]
    )


def test_untagged_none_or_false_is_no_filter(test_db):
    _library(test_db)
    assert test_db.get_filtered_image_count(untagged=None) == 4
    assert test_db.get_filtered_image_count(untagged=False) == 4


def test_tagging_a_picture_takes_it_out_of_the_view(test_db):
    ids = _library(test_db)
    _tag(test_db, ids["fresh"])
    assert test_db.get_filtered_image_count(untagged=True) == 1


def test_count_endpoints_and_select_all_use_the_filter(test_client):
    db = test_client.test_db
    ids = _library(db)

    assert test_client.get("/api/images/count?untagged=true").json()["total"] == 2
    posted = test_client.post("/api/images/count", json={"untagged": True})
    assert posted.status_code == 200, posted.text
    assert posted.json()["count"] == 2

    selection = test_client.post("/api/images/selection-ids", json={"untagged": True})
    assert selection.status_code == 200, selection.text
    assert sorted(selection.json()["image_ids"]) == sorted(
        [ids["fresh"], ids["captioned"]]
    )


def test_gallery_listing_accepts_the_filter(test_client):
    response = test_client.get("/api/images?untagged=true&limit=5")
    assert response.status_code == 200, response.text
