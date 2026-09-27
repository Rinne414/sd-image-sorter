"""Find-missed pages through every gap and says how many there are (V3.5 #14).

``POST /api/tags/coverage-gaps`` cut the list at ``limit`` (at most 2,000)
and reported ``total`` as the length of that cut list, so a tag missed on
more images than one page showed only one page and never said so. The
answer now carries the full ``total``, takes an ``offset`` and says
``has_more``.
"""

from __future__ import annotations

import database as db


def _near_miss_images(count: int) -> list[int]:
    ids = []
    for index in range(count):
        image_id = db.add_image(
            path=f"/test/gap-pages/{index}.png",
            filename=f"{index}.png",
            generator="comfyui",
            metadata_json="{}",
        )
        db.add_tags_batch(
            [
                {
                    "image_id": image_id,
                    "tags": [],
                    "tag_scores": {
                        "model": "wd-a",
                        "scores": [{"tag": "smile", "score": 0.30 + index * 0.01}],
                    },
                }
            ],
            default_source="tagger",
            replace_scope="pipeline",
        )
        ids.append(image_id)
    return ids


def _page(test_client, **extra) -> dict:
    response = test_client.post(
        "/api/tags/coverage-gaps",
        json={"tag": "smile", "band_low": 0.25, "band_high": 0.35, **extra},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_the_answer_counts_every_gap_and_pages_through_them(test_client, test_db):
    ids = _near_miss_images(5)
    best_first = list(reversed(ids))

    first = _page(test_client, limit=2)
    assert first["total"] == 5
    assert [gap["image_id"] for gap in first["gaps"]] == best_first[:2]
    assert first["has_more"] is True

    second = _page(test_client, limit=2, offset=2)
    assert [gap["image_id"] for gap in second["gaps"]] == best_first[2:4]
    assert second["has_more"] is True

    last = _page(test_client, limit=2, offset=4)
    assert [gap["image_id"] for gap in last["gaps"]] == best_first[4:]
    assert last["has_more"] is False
    assert last["total"] == 5
