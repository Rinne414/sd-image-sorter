"""Smart Tag says how many images it would skip before it runs.

With "Re-tag images that already have tags" off (the default), Smart Tag
drops every already-tagged library image: no tags, no natural-language
caption, no trigger word. The dialog asks /api/smart-tag/tagged-count first so
the user can choose between skipping those images and processing them.
"""

from pathlib import Path

from PIL import Image

import database as db


def _seed(tmp_path: Path, tagged_flags):
    src = tmp_path / "smart-tag-count"
    src.mkdir(exist_ok=True)
    ids = []
    for index, is_tagged in enumerate(tagged_flags):
        path = src / f"st_{index}.png"
        Image.new("RGB", (16, 16), color=(index * 40, 80, 120)).save(path)
        image_id = db.add_image(path=str(path), filename=path.name, metadata_json="{}")
        if is_tagged:
            with db.get_connection() as conn:
                conn.execute(
                    "UPDATE images SET tagged_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (image_id,),
                )
        ids.append(image_id)
    return ids


def test_counts_already_tagged_images_among_explicit_ids(test_client, tmp_path):
    ids = _seed(tmp_path, [True, False, True])

    response = test_client.post("/api/smart-tag/tagged-count", json={"image_ids": ids})

    assert response.status_code == 200, response.text
    assert response.json() == {"checked": 3, "already_tagged": 2}


def test_counts_images_behind_a_gallery_selection_token(test_client, tmp_path):
    _seed(tmp_path, [True, True, False, False])
    token = test_client.post("/api/images/selection-token", json={}).json()[
        "selection_token"
    ]

    response = test_client.post(
        "/api/smart-tag/tagged-count", json={"selection_token": token}
    )

    assert response.status_code == 200, response.text
    assert response.json() == {"checked": 4, "already_tagged": 2}


def test_no_sources_count_nothing(test_client):
    response = test_client.post("/api/smart-tag/tagged-count", json={})

    assert response.status_code == 200, response.text
    assert response.json() == {"checked": 0, "already_tagged": 0}
