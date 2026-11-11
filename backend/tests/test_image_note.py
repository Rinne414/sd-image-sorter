"""A note the user writes on a picture: stored, returned, and found by the text search."""

from __future__ import annotations


def _pictures(test_db, tmp_path, count=3):
    from PIL import Image

    ids = []
    for n in range(count):
        path = tmp_path / f"pic-{n}.png"
        Image.new("RGB", (8, 8)).save(path)
        ids.append(
            test_db.add_image(
                path=str(path),
                filename=path.name,
                prompt="1girl, rain",
                metadata_json="{}",
            )
        )
    return ids


def _found(test_db, text):
    page = test_db.get_images(search_query=text, limit=50)
    rows = (
        page
        if isinstance(page, list)
        else (page[0] if isinstance(page, tuple) else page["images"])
    )
    return sorted(row["id"] for row in rows)


def test_a_note_is_stored_returned_and_cleared(test_client, test_db, tmp_path):
    first, _second, _third = _pictures(test_db, tmp_path)

    saved = test_client.patch(
        f"/api/images/{first}/note",
        json={"note": "  cover candidate, fix the left hand  "},
    )
    assert saved.status_code == 200
    assert saved.json() == {
        "image_id": first,
        "note": "cover candidate, fix the left hand",
    }
    assert (
        test_client.get(f"/api/images/{first}").json()["image"]["note"]
        == "cover candidate, fix the left hand"
    )

    cleared = test_client.patch(f"/api/images/{first}/note", json={"note": ""})
    assert cleared.json()["note"] == ""
    assert test_client.get(f"/api/images/{first}").json()["image"]["note"] is None

    assert (
        test_client.patch("/api/images/999999/note", json={"note": "x"}).status_code
        == 404
    )
    assert (
        test_client.patch(
            f"/api/images/{first}/note", json={"note": "x" * 4001}
        ).status_code
        == 400
    )


def test_the_gallery_search_finds_the_words_of_a_note(test_db, tmp_path):
    first, second, third = _pictures(test_db, tmp_path)
    test_db.set_image_note(first, "cover candidate for the winter book")
    test_db.set_image_note(second, "fix_the_left_hand before posting")

    assert _found(test_db, "winter book") == [first]
    # Underscores and spaces are the same, as everywhere in the search.
    assert _found(test_db, "left hand") == [second]
    assert _found(test_db, "nothing says this") == []
    # The prompt is still searched, and a rewritten note is found by its new words only.
    assert _found(test_db, "rain") == [first, second, third]
    test_db.set_image_note(first, "rejected")
    assert _found(test_db, "winter book") == []
    assert _found(test_db, "rejected") == [first]


def test_the_migration_adds_the_column_once_and_keeps_the_search_index_in_step(
    test_db, tmp_path
):
    import importlib.util
    from pathlib import Path

    import database

    path = Path(database.__file__).with_name("migrations") / "069_image_note.py"
    spec = importlib.util.spec_from_file_location("migration_069_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    (picture,) = _pictures(test_db, tmp_path, 1)

    conn = database.get_connection()
    try:
        module.apply(conn)  # a second run changes nothing and raises nothing
        module.apply(conn)
        conn.commit()
        columns = [
            row[1] for row in conn.execute("PRAGMA table_info(images)").fetchall()
        ]
        assert columns.count("note") == 1
        triggers = {
            row[0]: row[1]
            for row in conn.execute(
                "SELECT name, sql FROM sqlite_master WHERE type = 'trigger'"
            ).fetchall()
        }
    finally:
        conn.close()

    if (
        "trg_image_text_fts_update" in triggers
    ):  # absent only without the trigram tokenizer
        assert "note" in triggers["trg_image_text_fts_update"]
        assert "note" in triggers["trg_image_text_fts_insert"]
    test_db.set_image_note(picture, "still searchable")
    assert _found(test_db, "still searchable") == [picture]
