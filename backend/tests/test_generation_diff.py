"""What changed between two pictures: only the differences, in the user's terms."""

from __future__ import annotations

import json

from services import generation_diff


def _picture(
    picture_id, prompt, negative="", checkpoint="modelA", loras=None, **params
):
    return {
        "id": picture_id,
        "filename": f"{picture_id}.png",
        "prompt": prompt,
        "negative_prompt": negative,
        "checkpoint": checkpoint,
        "metadata_json": json.dumps(
            {"_parsed": {"generation_params": params, "loras": loras or []}}
        ),
    }


def test_prompt_words_added_and_removed_ignore_weights_order_and_underscores():
    before = _picture(1, "1girl, (silver hair:1.2), rain, city_night", steps=28)
    after = _picture(
        2, "1girl, rain, silver_hair, [city night], umbrella, <lora:x:0.8>", steps=28
    )

    change = generation_diff.compare(before, after)

    assert change["prompt"] == {"added": ["umbrella"], "removed": []}
    assert (
        change["settings"] == []
        and change["same"] is False
        and change["comparable"] is True
    )


def test_settings_are_listed_only_when_they_differ_and_7_equals_7_point_0():
    before = _picture(
        1,
        "a",
        steps=28,
        cfg_scale=7.0,
        sampler="Euler a",
        width=832,
        height=1216,
        seed=1,
    )
    after = _picture(
        2,
        "a",
        checkpoint="modelB",
        steps=30,
        cfg_scale=7,
        sampler="Euler a",
        width=1024,
        height=1024,
        seed=2,
    )

    change = generation_diff.compare(before, after)

    assert change["settings"] == [
        {"key": "model", "before": "modelA", "after": "modelB"},
        {"key": "steps", "before": 28, "after": 30},
        {"key": "size", "before": "832 x 1216", "after": "1024 x 1024"},
    ]
    # The seed is told apart: it differs on almost every try.
    assert change["seed"] == {"before": 1, "after": 2, "same": False}


def test_loras_added_removed_and_reweighted():
    before = _picture(
        1,
        "a",
        loras=[{"name": "detail", "weight": 0.8}, {"name": "old", "weight": 1}],
        steps=20,
    )
    after = _picture(
        2,
        "a",
        loras=[{"name": "detail", "weight": 0.6}, {"name": "new", "weight": 0.5}],
        steps=20,
    )

    change = generation_diff.compare(before, after)

    assert change["loras"] == {
        "added": [{"name": "new", "weight": 0.5}],
        "removed": [{"name": "old", "weight": 1}],
        "reweighted": [{"name": "detail", "before": 0.8, "after": 0.6}],
    }


def test_identical_recipes_say_same_and_a_picture_without_data_is_not_comparable():
    one = _picture(1, "1girl, rain", "lowres", steps=28, seed=5)
    two = _picture(2, "1girl, rain", "lowres", steps=28, seed=9)
    assert generation_diff.compare(one, two)["same"] is True

    bare = {"id": 3, "filename": "3.png", "prompt": "", "metadata_json": "not json"}
    change = generation_diff.compare(bare, two)
    assert change["comparable"] is False and change["same"] is False


def test_negative_prompt_changes_are_reported_apart():
    change = generation_diff.compare(
        _picture(1, "a", "lowres, bad hands", steps=1),
        _picture(2, "a", "lowres, blurry", steps=1),
    )

    assert change["negative_prompt"] == {"added": ["blurry"], "removed": ["bad hands"]}
    assert change["prompt"] == {"added": [], "removed": []}


def test_the_endpoint_compares_with_the_picture_made_just_before(
    test_client, test_db, tmp_path
):
    from PIL import Image

    ids = []
    for n, (prompt, steps) in enumerate(
        [("1girl, rain", 20), ("", 0), ("1girl, rain, umbrella", 24)]
    ):
        path = tmp_path / f"{n}.png"
        Image.new("RGB", (8, 8)).save(path)
        meta = json.dumps(
            {"_parsed": {"generation_params": {"steps": steps} if steps else {}}}
        )
        ids.append(
            test_db.add_image(
                path=str(path), filename=path.name, prompt=prompt, metadata_json=meta
            )
        )

    # The picture between them has no generation data: it is skipped.
    body = test_client.get(f"/api/images/{ids[2]}/changes").json()
    assert body["before"]["id"] == ids[0] and body["picked"] is False
    assert body["prompt"]["added"] == ["umbrella"]
    assert body["settings"] == [{"key": "steps", "before": 20, "after": 24}]

    # The first picture has nothing before it.
    first = test_client.get(f"/api/images/{ids[0]}/changes").json()
    assert first["before"] is None and first["comparable"] is False

    # A picked picture, the other way round.
    picked = test_client.get(
        f"/api/images/{ids[0]}/changes", params={"against": ids[2]}
    ).json()
    assert picked["picked"] is True and picked["prompt"]["removed"] == ["umbrella"]
    assert (
        test_client.get(
            f"/api/images/{ids[0]}/changes", params={"against": 999999}
        ).status_code
        == 404
    )


def test_the_picture_before_is_one_of_the_same_library(test_client, test_db, tmp_path):
    """Two libraries filling up side by side: another library's picture is not "the one before"."""
    from PIL import Image

    def picture(name, prompt):
        path = tmp_path / name
        Image.new("RGB", (8, 8)).save(path)
        return test_db.add_image(
            path=str(path), filename=name, prompt=prompt, metadata_json="{}"
        )

    mine_first = picture("mine-1.png", "1girl, rain")
    theirs = picture("theirs.png", "landscape, mountains")
    mine_second = picture("mine-2.png", "1girl, rain, umbrella")
    conn = test_db.get_connection()
    try:
        conn.execute("UPDATE images SET library_id = 'other' WHERE id = ?", (theirs,))
        conn.commit()
    finally:
        conn.close()

    body = test_client.get(f"/api/images/{mine_second}/changes").json()

    assert body["before"]["id"] == mine_first
