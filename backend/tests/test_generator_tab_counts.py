"""The generator tabs count what the current filters leave (2026-10-26).

The tabs above the gallery showed the whole library's count per generator even
while a tag or search filter was on, so "ComfyUI (500)" opened a gallery of 20.
POST /api/images/generator-counts takes the gallery filter payload and counts
per generator under every filter except the generator ones (the tabs choose
the generator), so each tab shows what clicking it would show.
"""

import database as db

ROWS = [
    ("a.png", "comfyui", ["1girl", "smile"]),
    ("b.png", "comfyui", ["1girl"]),
    ("c.png", "comfyui", ["landscape"]),
    ("d.png", "nai", ["1girl"]),
    ("e.png", "webui", ["landscape"]),
    ("f.png", "unknown", ["1girl"]),
]


def _seed(tmp_path):
    ids = {}
    for name, generator, tags in ROWS:
        path = tmp_path / name
        path.write_bytes(b"png")
        image_id = db.add_image(path=str(path), filename=name, generator=generator)
        db.add_tags(image_id, [{"tag": tag, "confidence": 0.9} for tag in tags])
        ids[name] = image_id
    return ids


def _counts(test_client, **payload):
    response = test_client.post("/api/images/generator-counts", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def test_without_filters_every_generator_is_counted(test_client, test_db, tmp_path):
    _seed(tmp_path)

    body = _counts(test_client)

    assert body["counts"] == {"comfyui": 3, "nai": 1, "webui": 1, "unknown": 1}
    assert body["total"] == 6
    assert body["exact"] is True


def test_a_tag_filter_narrows_every_tab(test_client, test_db, tmp_path):
    _seed(tmp_path)

    body = _counts(test_client, tags=["1girl"])

    assert body["counts"] == {"comfyui": 2, "nai": 1, "unknown": 1}
    assert body["total"] == 4


def test_the_generator_filters_do_not_hide_the_other_tabs(
    test_client, test_db, tmp_path
):
    """The tabs choose the generator: the open tab must not zero the others."""
    _seed(tmp_path)

    body = _counts(
        test_client,
        tags=["1girl"],
        generators=["comfyui"],
        excludeGenerators=["nai"],
    )

    assert body["counts"] == {"comfyui": 2, "nai": 1, "unknown": 1}


def test_each_tab_matches_what_the_gallery_shows(test_client, test_db, tmp_path):
    _seed(tmp_path)
    counts = _counts(test_client, tags=["landscape"])["counts"]

    for generator, expected in counts.items():
        listed = test_client.post(
            "/api/images/count",
            json={"tags": ["landscape"], "generators": [generator]},
        ).json()["count"]
        assert listed == expected, generator


def test_the_database_count_and_the_tab_counts_agree(test_db, tmp_path):
    _seed(tmp_path)

    counts = db.get_filtered_generator_counts(tags=["smile"], generators=["nai"])

    assert counts == {"comfyui": 1}
    assert db.get_filtered_image_count(tags=["smile"]) == 1
