"""Regression coverage for the short-lived Gallery session scope."""

from pathlib import Path


def _seed_images(db):
    db.add_images_batch(
        [
            {
                "path": str(Path("/gallery/session-a.png")),
                "filename": "session-a.png",
                "generator": "webui",
                "prompt": "session a",
                "width": 64,
                "height": 64,
            },
            {
                "path": str(Path("/gallery/library-b.png")),
                "filename": "library-b.png",
                "generator": "webui",
                "prompt": "library b",
                "width": 64,
                "height": 64,
            },
        ]
    )
    return db.get_images(sort_by="newest", limit=10)


def test_session_scope_is_independent_and_clears_on_restart(test_db):
    import database as db

    rows = _seed_images(db)
    first_id = int(rows[0]["id"])
    second_id = int(rows[1]["id"])
    db.add_gallery_session_image_ids([first_id])

    assert [row["id"] for row in db.get_images(scope="current_session", limit=10)] == [first_id]
    assert db.get_images_paginated(scope="current_session", limit=10)["total"] == 1
    assert {row["id"] for row in db.get_images(scope="library", limit=10)} == {first_id, second_id}

    db.init_db()

    assert db.get_gallery_session_image_ids() == []
    assert {row["id"] for row in db.get_images(scope="library", limit=10)} == {first_id, second_id}
    assert db.get_images(scope="current_session", limit=10) == []


def test_session_scope_composes_with_collection_and_count(test_db):
    import database as db

    rows = _seed_images(db)
    first_id = int(rows[0]["id"])
    second_id = int(rows[1]["id"])
    collection = db.create_collection("Session subset")
    collection_id = int(collection["id"])
    db.set_collection_membership(collection_id, first_id, True)
    db.set_collection_membership(collection_id, second_id, True)
    db.add_gallery_session_image_ids([first_id])

    assert db.get_filtered_image_count(scope="current_session", collection_id=collection_id) == 1
    assert db.get_filtered_image_ids(scope="current_session", collection_id=collection_id) == [first_id]


def test_scanned_paths_join_the_current_session(test_db):
    import database as db

    rows = _seed_images(db)
    db.add_gallery_session_paths([rows[1]["path"]])

    assert db.get_gallery_session_image_ids() == [int(rows[1]["id"])]


def test_newly_scanned_images_join_the_current_session_after_indexing(test_db, tmp_path):
    from PIL import Image

    import database as db
    from image_manager import scan_folder

    image_path = tmp_path / "new-session-image.png"
    Image.new("RGB", (16, 16), color="white").save(image_path)

    result = scan_folder(str(tmp_path), recursive=False, quick_import=True)

    assert result["new"] == 1
    image = db.get_image_by_path(str(image_path))
    assert image is not None
    assert db.get_gallery_session_image_ids() == [int(image["id"])]
