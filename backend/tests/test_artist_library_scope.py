"""Artist results follow the current library, the way the artist stats already do.

One artist's images (and their count) come only from the library the request
names (X-SD-Library-Id), and clearing results clears only that library's; the
other library's results stay. Before this, both read or wrote every library.
"""

from __future__ import annotations

import db_libraries as libdb
from library_context import (
    MAIN_LIBRARY_ID,
    reset_current_library_id,
    set_current_library_id,
)


def _image(test_db, name: str, library_id: str) -> int:
    token = set_current_library_id(library_id)
    try:
        return int(
            test_db.add_image(
                path=f"/tmp/{name}.png", filename=f"{name}.png", metadata_json="{}"
            )
        )
    finally:
        reset_current_library_id(token)


def _predict(test_db, image_id: int, artist: str, confidence: float) -> None:
    with test_db.get_db() as conn:
        conn.execute(
            "INSERT INTO artist_predictions (image_id, artist, confidence, top_predictions) VALUES (?, ?, ?, '[]')",
            (image_id, artist, confidence),
        )


def _two_libraries(test_db) -> tuple[str, list[int], list[int]]:
    libdb.ensure_default_library()
    other = libdb.create_library("Artist scope other")["id"]
    main_ids = [
        _image(test_db, f"artist-scope-main-{i}", MAIN_LIBRARY_ID) for i in range(2)
    ]
    other_ids = [_image(test_db, "artist-scope-other-0", other)]
    for image_id, confidence in zip(main_ids + other_ids, (0.9, 0.5, 0.95)):
        _predict(test_db, image_id, "shared_artist", confidence)
    return other, main_ids, other_ids


def _header(library_id: str) -> dict[str, str]:
    return {"X-SD-Library-Id": library_id}


def _remaining(test_db) -> set[int]:
    with test_db.get_db() as conn:
        return {
            int(row[0])
            for row in conn.execute("SELECT image_id FROM artist_predictions")
        }


def test_one_artists_images_come_only_from_the_current_library(test_client, test_db):
    other, main_ids, other_ids = _two_libraries(test_db)

    main = test_client.get(
        "/api/artists/images/shared_artist", headers=_header(MAIN_LIBRARY_ID)
    ).json()
    elsewhere = test_client.get(
        "/api/artists/images/shared_artist", headers=_header(other)
    ).json()

    assert main["total"] == 2
    assert [img["image_id"] for img in main["images"]] == main_ids
    assert main["has_more"] is False
    assert elsewhere["total"] == 1
    assert [img["image_id"] for img in elsewhere["images"]] == other_ids


def test_the_images_count_matches_the_stats_of_the_same_library(test_client, test_db):
    other, _main_ids, _other_ids = _two_libraries(test_db)

    stats = test_client.get("/api/artists/stats", headers=_header(other)).json()
    images = test_client.get(
        "/api/artists/images/shared_artist", headers=_header(other)
    ).json()

    assert stats["artist_counts"]["shared_artist"] == images["total"] == 1


def test_clearing_removes_only_the_current_librarys_results(test_client, test_db):
    other, main_ids, other_ids = _two_libraries(test_db)

    response = test_client.delete("/api/artists/clear", headers=_header(other))

    assert response.status_code == 200
    assert response.json()["cleared"] == 1
    assert _remaining(test_db) == set(main_ids)

    test_client.delete("/api/artists/clear", headers=_header(MAIN_LIBRARY_ID))
    assert _remaining(test_db) == set()
    assert other_ids  # the other library's image rows themselves are untouched
    with test_db.get_db() as conn:
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM images WHERE id = ?", (other_ids[0],)
            ).fetchone()[0]
            == 1
        )
