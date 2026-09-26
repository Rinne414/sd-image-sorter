"""Tag backup import/export stays inside the library the request names.

Before V4 slice 6a, ``export_tags`` read every tagged image of every library
and ``import_tags`` matched rows by path (``get_image_by_path``) and then by
bare file name across the whole ``images`` table. A backup imported while
working in one library could therefore land on another library's image whose
path has the same shape (``D:/Pics/a.png`` vs ``d:/pics/a.png``) or that merely
shares a file name, and the file-name fallback picked one of several
same-named images arbitrarily.

It also pins the library-health cache being dropped by tag writes (V3.5 issue
#25): the health report reads ``tagged_at`` (``untagged``, tagged share), so a
tag write must not leave the report stale for the 60 s TTL.
"""

from __future__ import annotations

import pytest

import database as db

LIBRARY_HEADER = "X-SD-Library-Id"
STUDIO = {LIBRARY_HEADER: "studio"}
MAIN = {LIBRARY_HEADER: "main"}


@pytest.fixture(autouse=True)
def _cold_health_cache():
    from services.sorting_service import invalidate_library_health_cache

    invalidate_library_health_cache()
    yield
    invalidate_library_health_cache()


def _insert(path: str, filename: str, library_id: str, *, tagged: bool = False) -> int:
    """A readable image row in ``library_id`` (raw SQL: add_image would merge case variants)."""
    with db.get_db() as conn:
        cursor = conn.execute(
            "INSERT INTO images (path, filename, library_id, is_readable, metadata_status, created_at, tagged_at) "
            "VALUES (?, ?, ?, 1, 'complete', datetime('now'), CASE WHEN ? THEN datetime('now') END)",
            (path, filename, library_id, 1 if tagged else 0),
        )
        conn.commit()
        return int(cursor.lastrowid)


def _tags_of(image_id: int) -> set[str]:
    return {row["tag"] for row in db.get_image_tags(image_id)}


def _import(client, images, *, headers=None, overwrite=False):
    response = client.post(
        "/api/tags/import",
        json={"images": images, "overwrite": overwrite},
        headers=headers or {},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _entry(path: str, filename: str, tag: str) -> dict:
    return {
        "path": path,
        "filename": filename,
        "tags": [{"tag": tag, "confidence": 0.9}],
    }


def test_import_by_path_writes_only_to_the_current_librarys_image(test_client):
    main_id = _insert("D:/Pics/shared.png", "shared.png", "main")
    studio_id = _insert("d:/pics/shared.png", "shared.png", "studio")

    # The backup names main's exact path; the user is working in studio.
    result = _import(
        test_client,
        [_entry("D:/Pics/shared.png", "shared.png", "from_backup")],
        headers=STUDIO,
    )

    assert result["imported"] == 1
    assert _tags_of(studio_id) == {"from_backup"}
    assert _tags_of(main_id) == set()


def test_import_by_file_name_never_reaches_another_library(test_client):
    main_id = _insert("D:/Main/lonely.png", "lonely.png", "main")

    result = _import(
        test_client,
        [_entry("E:/Elsewhere/lonely.png", "lonely.png", "stray")],
        headers=STUDIO,
    )

    assert result["imported"] == 0
    assert result["skipped"] == 1
    assert result["not_found"] == 1
    assert _tags_of(main_id) == set()


def test_ambiguous_file_name_is_skipped_and_counted_not_guessed(test_client):
    first = _insert("D:/Studio/a/dup.png", "dup.png", "studio")
    second = _insert("D:/Studio/b/dup.png", "dup.png", "studio")
    # A same-named image in another library does not make studio's match ambiguous or not.
    _insert("D:/Main/dup.png", "dup.png", "main")

    result = _import(
        test_client,
        [_entry("E:/Moved/dup.png", "dup.png", "which_one")],
        headers=STUDIO,
    )

    assert result["imported"] == 0
    assert result["skipped"] == 1
    assert result["ambiguous"] == 1
    assert _tags_of(first) == set()
    assert _tags_of(second) == set()


def test_import_reports_why_each_row_was_skipped(test_client):
    fresh = _insert("D:/Studio/fresh.png", "fresh.png", "studio")
    tagged = _insert("D:/Studio/tagged.png", "tagged.png", "studio", tagged=True)
    _insert("D:/Studio/x/twin.png", "twin.png", "studio")
    _insert("D:/Studio/y/twin.png", "twin.png", "studio")

    result = _import(
        test_client,
        [
            _entry("D:/Studio/fresh.png", "fresh.png", "first"),
            _entry("D:/Studio/fresh.png", "fresh.png", "again"),  # listed twice
            _entry("D:/Studio/tagged.png", "tagged.png", "keep_mine"),  # already tagged
            _entry("E:/Gone/twin.png", "twin.png", "ambiguous"),
            _entry("E:/Gone/nowhere.png", "nowhere.png", "missing"),
            {
                "path": "D:/Studio/fresh.png",
                "filename": "fresh.png",
                "tags": [],
            },  # nothing to import
        ],
        headers=STUDIO,
    )

    assert result == {
        "imported": 1,
        "skipped": 4,
        "not_found": 1,
        "ambiguous": 1,
        "already_tagged": 1,
        "duplicate": 1,
    }
    assert _tags_of(fresh) == {"first"}
    assert _tags_of(tagged) == set()


def test_export_holds_only_the_current_librarys_tagged_images(test_client):
    _insert("D:/Main/m1.png", "m1.png", "main", tagged=True)
    _insert("D:/Main/m2.png", "m2.png", "main", tagged=True)
    _insert("D:/Main/untagged.png", "untagged.png", "main")
    _insert("D:/Studio/s1.png", "s1.png", "studio", tagged=True)

    studio = test_client.get("/api/tags/export", headers=STUDIO).json()
    main = test_client.get("/api/tags/export", headers=MAIN).json()

    assert studio["count"] == 1
    assert [row["filename"] for row in studio["images"]] == ["s1.png"]
    assert main["count"] == 2
    assert sorted(row["filename"] for row in main["images"]) == ["m1.png", "m2.png"]


def test_a_request_without_the_library_header_works_on_the_main_library(test_client):
    main_path_id = _insert("D:/Main/by_path.png", "by_path.png", "main")
    main_name_id = _insert("D:/Main/by_name.png", "by_name.png", "main")
    studio_id = _insert("D:/Studio/by_name.png", "by_name.png", "studio", tagged=True)

    result = _import(
        test_client,
        [
            _entry("D:/Main/by_path.png", "by_path.png", "path_hit"),
            _entry("E:/Old/by_name.png", "by_name.png", "name_hit"),
        ],
    )

    assert result["imported"] == 2
    assert _tags_of(main_path_id) == {"path_hit"}
    assert _tags_of(main_name_id) == {"name_hit"}
    assert _tags_of(studio_id) == set()

    exported = test_client.get("/api/tags/export").json()
    assert sorted(row["filename"] for row in exported["images"]) == [
        "by_name.png",
        "by_path.png",
    ]


def test_import_drops_the_cached_library_health_report(test_client):
    from services.sorting_service import _LIBRARY_HEALTH_CACHE

    _insert("D:/Studio/h1.png", "h1.png", "studio")
    _insert("D:/Studio/h2.png", "h2.png", "studio")

    before = test_client.get(
        "/api/library-health?sample_limit=4", headers=STUDIO
    ).json()
    assert before["issue_counts"]["untagged"] == 2
    assert _LIBRARY_HEALTH_CACHE  # warm

    _import(
        test_client, [_entry("D:/Studio/h1.png", "h1.png", "healthy")], headers=STUDIO
    )

    assert _LIBRARY_HEALTH_CACHE == {}, (
        "a tag import must drop the cached health report"
    )
    after = test_client.get("/api/library-health?sample_limit=4", headers=STUDIO).json()
    assert after["issue_counts"]["untagged"] == 1


@pytest.mark.parametrize("writer", ["add_tags", "add_tags_batch", "bulk_add"])
def test_every_tag_write_path_drops_the_cached_library_health_report(
    test_client, writer
):
    from services.sorting_service import _LIBRARY_HEALTH_CACHE

    image_id = _insert("D:/Main/w.png", "w.png", "main")
    assert (
        test_client.get("/api/library-health?sample_limit=4").json()["issue_counts"][
            "untagged"
        ]
        == 1
    )
    assert _LIBRARY_HEALTH_CACHE  # warm

    if writer == "add_tags":
        db.add_tags(image_id, [{"tag": "t", "confidence": 0.9}])
    elif writer == "add_tags_batch":
        db.add_tags_batch(
            [{"image_id": image_id, "tags": [{"tag": "t", "confidence": 0.9}]}]
        )
    else:
        response = test_client.post(
            "/api/tags/bulk/add", json={"image_ids": [image_id], "tags": ["t"]}
        )
        assert response.status_code == 200, response.text

    assert _LIBRARY_HEALTH_CACHE == {}, f"{writer} must drop the cached health report"
    assert (
        test_client.get("/api/library-health?sample_limit=4").json()["issue_counts"][
            "untagged"
        ]
        == 0
    )
