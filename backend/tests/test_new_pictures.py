"""New pictures: the ones made after a moment the caller remembers."""

from __future__ import annotations

from datetime import datetime, timedelta


def _picture(test_db, tmp_path, name, made):
    from PIL import Image

    path = tmp_path / name
    Image.new("RGB", (8, 8)).save(path)
    return test_db.add_image(
        path=str(path),
        filename=name,
        prompt="1girl",
        metadata_json="{}",
        created_at=made,
    )


def test_everything_is_new_at_first_and_the_answer_carries_the_next_marker(
    test_client, test_db, tmp_path
):
    start = datetime(2026, 11, 1, 9, 0, 0)
    ids = [
        _picture(test_db, tmp_path, f"p{n}.png", start + timedelta(hours=n))
        for n in range(3)
    ]

    first = test_client.get("/api/new-pictures").json()

    assert first["ids"] == list(reversed(ids))  # newest first
    assert first["count"] == 3
    assert first["after"] is None
    marker = first["newest_time"]
    assert marker.startswith("2026-11-01 11:00:00")

    # Nothing was made since: nothing is new, and the marker stays where it is.
    again = test_client.get("/api/new-pictures", params={"after": marker}).json()
    assert again["ids"] == []
    assert again["newest_time"] == marker


def test_only_pictures_made_after_the_marker_are_new(test_client, test_db, tmp_path):
    start = datetime(2026, 11, 1, 9, 0, 0)
    _picture(test_db, tmp_path, "old.png", start)
    marker = test_client.get("/api/new-pictures").json()["newest_time"]
    late = _picture(test_db, tmp_path, "late.png", start + timedelta(minutes=5))
    later = _picture(test_db, tmp_path, "later.png", start + timedelta(days=2))

    answer = test_client.get("/api/new-pictures", params={"after": marker}).json()

    assert answer["ids"] == [later, late]
    assert answer["newest_time"].startswith("2026-11-03 09:00:00")
    # A plain local time works as a marker too (the first time, when none is remembered).
    typed = test_client.get(
        "/api/new-pictures", params={"after": "2026-11-02 00:00:00"}
    ).json()
    assert typed["ids"] == [later]


def test_a_reread_does_not_make_an_old_picture_new(test_client, test_db, tmp_path):
    made = datetime(2026, 10, 1, 8, 0, 0)
    old = _picture(test_db, tmp_path, "old.png", made)
    marker = test_client.get("/api/new-pictures").json()["newest_time"]

    # Re-indexing touches indexed_at, never the picture's own time.
    conn = test_db.get_connection()
    try:
        conn.execute(
            "UPDATE images SET indexed_at = CURRENT_TIMESTAMP WHERE id = ?", (old,)
        )
        conn.commit()
    finally:
        conn.close()

    assert (
        test_client.get("/api/new-pictures", params={"after": marker}).json()["ids"]
        == []
    )


def test_an_empty_library_has_nothing_new(test_client):
    answer = test_client.get("/api/new-pictures").json()

    assert answer == {
        "after": None,
        "ids": [],
        "count": 0,
        "newest_time": None,
        "remembered": False,
    }


def test_the_marker_is_kept_by_the_program_and_used_when_none_is_passed(
    test_client, test_db, tmp_path
):
    start = datetime(2026, 11, 1, 9, 0, 0)
    _picture(test_db, tmp_path, "old.png", start)
    first = test_client.get("/api/new-pictures").json()
    assert first["remembered"] is False and first["count"] == 1

    stored = test_client.patch(
        "/api/new-pictures/marker", json={"marker": first["newest_time"]}
    ).json()
    assert stored == {"marker": first["newest_time"], "previous": None}
    late = _picture(test_db, tmp_path, "late.png", start + timedelta(hours=1))

    # Any client (the browser, the desktop program) now sees the same "new".
    again = test_client.get("/api/new-pictures").json()
    assert again["remembered"] is True
    assert again["ids"] == [late]

    # Undo: the marker before comes back (here: none), and everything counts again.
    undone = test_client.patch("/api/new-pictures/marker", json={"marker": None}).json()
    assert undone["previous"] == first["newest_time"]
    assert test_client.get("/api/new-pictures").json()["count"] == 2


def test_with_no_marker_a_window_of_days_can_stand_in(test_client, test_db, tmp_path):
    now = datetime.now().replace(microsecond=0)
    _picture(test_db, tmp_path, "long-ago.png", now - timedelta(days=30))
    recent = _picture(test_db, tmp_path, "recent.png", now - timedelta(days=2))

    answer = test_client.get("/api/new-pictures", params={"default_days": 7}).json()

    assert answer["ids"] == [recent] and answer["remembered"] is False


def test_each_library_has_its_own_marker(test_client, test_db, tmp_path):
    _picture(test_db, tmp_path, "one.png", datetime(2026, 11, 1, 9, 0, 0))
    test_client.patch("/api/new-pictures/marker", json={"marker": "2026-11-02 00:00:00"})

    other = test_client.get(
        "/api/new-pictures", headers={"X-SD-Library-Id": "other"}
    ).json()

    assert other["remembered"] is False
    assert test_client.get("/api/new-pictures").json()["remembered"] is True
