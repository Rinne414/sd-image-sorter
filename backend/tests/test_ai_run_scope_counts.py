"""Whole-library AI runs say how many images they will process.

"AI Tag Images" (no selection) and the Aesthetic tab both run over the whole
library; the tag modal and the aesthetic panel now show the count first.
"""

from pathlib import Path

from PIL import Image

import database as db


def _seed(tmp_path: Path, rows):
    """rows: list of (is_tagged, aesthetic_score_or_None)."""
    src = tmp_path / "scope-count"
    src.mkdir(exist_ok=True)
    for index, (is_tagged, score) in enumerate(rows):
        path = src / f"sc_{index}.png"
        Image.new("RGB", (8, 8), color=(index * 30, 60, 90)).save(path)
        image_id = db.add_image(path=str(path), filename=path.name, metadata_json="{}")
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE images SET tagged_at = CASE WHEN ? THEN CURRENT_TIMESTAMP END, "
                "aesthetic_score = ? WHERE id = ?",
                (1 if is_tagged else 0, score, image_id),
            )


def test_tag_scope_count_counts_untagged_images_by_default(test_client, tmp_path):
    _seed(tmp_path, [(True, None), (False, None), (False, 5.0)])

    response = test_client.get("/api/tag/scope-count")

    assert response.status_code == 200, response.text
    assert response.json() == {"count": 2, "retag_all": False}


def test_tag_scope_count_counts_every_image_when_retagging_all(test_client, tmp_path):
    _seed(tmp_path, [(True, None), (False, None), (False, 5.0)])

    response = test_client.get("/api/tag/scope-count", params={"retag_all": "true"})

    assert response.status_code == 200, response.text
    assert response.json() == {"count": 3, "retag_all": True}


def test_aesthetic_status_says_how_many_images_are_still_unscored(
    test_client, tmp_path
):
    _seed(tmp_path, [(True, None), (False, None), (False, 5.0)])

    response = test_client.get("/api/aesthetic/status")

    assert response.status_code == 200, response.text
    assert response.json()["to_score_count"] == 2
