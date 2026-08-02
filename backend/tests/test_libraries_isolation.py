"""Multi-library isolation: clear/delete must not leak across workspaces."""

from __future__ import annotations

import database as db
from library_context import MAIN_LIBRARY_ID, set_current_library_id, reset_current_library_id
import db_libraries as libdb


def _insert_image(path: str, library_id: str = MAIN_LIBRARY_ID) -> int:
    token = set_current_library_id(library_id)
    try:
        filename = path.replace("\\", "/").rsplit("/", 1)[-1]
        image_id = db.add_image(
            path=path,
            filename=filename,
            generator="unknown",
            width=64,
            height=64,
            file_size=100,
            is_readable=True,
        )
        return int(image_id)
    finally:
        reset_current_library_id(token)


def test_main_library_seeded_and_default_isolation(test_db):
    libdb.ensure_default_library()
    libs = libdb.list_libraries()
    assert any(item["id"] == MAIN_LIBRARY_ID and item["is_default"] for item in libs)

    a = _insert_image("/tmp/lib-main-a.png", MAIN_LIBRARY_ID)
    assert a > 0

    token = set_current_library_id(MAIN_LIBRARY_ID)
    try:
        rows = db.get_images(limit=50)
    finally:
        reset_current_library_id(token)
    ids = {int(r["id"]) for r in rows}
    assert a in ids


def test_clear_current_library_keeps_other_libraries(test_db):
    libdb.ensure_default_library()
    other = libdb.create_library("Training set")
    other_id = other["id"]

    main_id = _insert_image("/tmp/lib-clear-main.png", MAIN_LIBRARY_ID)
    other_img = _insert_image("/tmp/lib-clear-other.png", other_id)

    removed = libdb.clear_library_images(MAIN_LIBRARY_ID)
    assert removed >= 1

    with db.get_db() as conn:
        main_left = conn.execute(
            "SELECT COUNT(*) AS c FROM images WHERE COALESCE(library_id,'main') = ?",
            (MAIN_LIBRARY_ID,),
        ).fetchone()["c"]
        other_left = conn.execute(
            "SELECT COUNT(*) AS c FROM images WHERE COALESCE(library_id,'main') = ?",
            (other_id,),
        ).fetchone()["c"]
        still_other = conn.execute(
            "SELECT id FROM images WHERE id = ?",
            (other_img,),
        ).fetchone()

    assert int(main_left) == 0
    assert int(other_left) >= 1
    assert still_other is not None
    assert int(still_other["id"]) == other_img
    # main image gone
    with db.get_db() as conn:
        assert conn.execute("SELECT 1 FROM images WHERE id = ?", (main_id,)).fetchone() is None


def test_delete_library_protects_main_and_removes_images(test_db):
    libdb.ensure_default_library()
    other = libdb.create_library("Temp pack")
    other_id = other["id"]
    img = _insert_image("/tmp/lib-del-other.png", other_id)

    try:
        libdb.delete_library(MAIN_LIBRARY_ID)
        assert False, "expected PermissionError"
    except PermissionError:
        pass

    result = libdb.delete_library(other_id)
    assert result["id"] == other_id
    assert result["removed_images"] >= 1
    assert libdb.get_library(other_id) is None
    with db.get_db() as conn:
        assert conn.execute("SELECT 1 FROM images WHERE id = ?", (img,)).fetchone() is None


def test_list_query_does_not_cross_libraries(test_db):
    libdb.ensure_default_library()
    other = libdb.create_library("Isolated")
    other_id = other["id"]
    main_img = _insert_image("/tmp/lib-iso-main.png", MAIN_LIBRARY_ID)
    other_img = _insert_image("/tmp/lib-iso-other.png", other_id)

    token = set_current_library_id(MAIN_LIBRARY_ID)
    try:
        main_rows = db.get_images(limit=100)
    finally:
        reset_current_library_id(token)
    main_ids = {int(r["id"]) for r in main_rows}
    assert main_img in main_ids
    assert other_img not in main_ids

    token = set_current_library_id(other_id)
    try:
        other_rows = db.get_images(limit=100)
    finally:
        reset_current_library_id(token)
    other_ids = {int(r["id"]) for r in other_rows}
    assert other_img in other_ids
    assert main_img not in other_ids


def test_path_conflict_does_not_steal_across_libraries(test_db):
    """Same disk path is unique — scanning into library B must not reassign A's row."""
    libdb.ensure_default_library()
    other = libdb.create_library("Training pack")
    other_id = other["id"]
    shared_path = "/tmp/lib-path-conflict-shared.png"

    main_id = _insert_image(shared_path, MAIN_LIBRARY_ID)
    with db.get_db() as conn:
        before = conn.execute(
            "SELECT id, COALESCE(library_id,'main') AS library_id FROM images WHERE id = ?",
            (main_id,),
        ).fetchone()
    assert before is not None
    assert str(before["library_id"]) == MAIN_LIBRARY_ID

    token = set_current_library_id(other_id)
    try:
        result_id, status = db.add_image(
            path=shared_path,
            filename="lib-path-conflict-shared.png",
            generator="unknown",
            width=64,
            height=64,
            file_size=100,
            is_readable=True,
            return_status=True,
        )
    finally:
        reset_current_library_id(token)

    assert int(result_id) == main_id
    assert status == "skipped_other_library"

    with db.get_db() as conn:
        after = conn.execute(
            "SELECT id, COALESCE(library_id,'main') AS library_id, COUNT(*) AS c FROM images WHERE path = ?",
            (shared_path,),
        ).fetchone()
        # path still one row, still owned by main
        row = conn.execute(
            "SELECT COALESCE(library_id,'main') AS library_id FROM images WHERE id = ?",
            (main_id,),
        ).fetchone()
        other_count = conn.execute(
            "SELECT COUNT(*) AS c FROM images WHERE COALESCE(library_id,'main') = ?",
            (other_id,),
        ).fetchone()["c"]

    assert str(row["library_id"]) == MAIN_LIBRARY_ID
    assert int(other_count) == 0

    token = set_current_library_id(other_id)
    try:
        other_rows = db.get_images(limit=100)
    finally:
        reset_current_library_id(token)
    assert all(int(r["id"]) != main_id for r in other_rows)


def test_claim_paths_and_move_images_between_libraries(test_db):
    libdb.ensure_default_library()
    other = libdb.create_library("Claim target")
    other_id = other["id"]
    path = "/tmp/lib-claim-move.png"
    img_id = _insert_image(path, MAIN_LIBRARY_ID)

    claimed = libdb.claim_paths_to_library([path], other_id)
    assert claimed["moved"] == 1
    with db.get_db() as conn:
        row = conn.execute(
            "SELECT COALESCE(library_id,'main') AS library_id FROM images WHERE id = ?",
            (img_id,),
        ).fetchone()
    assert str(row["library_id"]) == other_id

    moved = libdb.move_images_to_library([img_id], MAIN_LIBRARY_ID)
    assert moved["moved"] == 1
    with db.get_db() as conn:
        row = conn.execute(
            "SELECT COALESCE(library_id,'main') AS library_id FROM images WHERE id = ?",
            (img_id,),
        ).fetchone()
    assert str(row["library_id"]) == MAIN_LIBRARY_ID


def test_export_library_index_contains_images_and_roots(test_db):
    libdb.ensure_default_library()
    other = libdb.create_library("Export me")
    other_id = other["id"]
    _insert_image("/tmp/lib-export-a.png", other_id)
    token = set_current_library_id(other_id)
    try:
        db.add_library_root("/tmp/lib-export-root", label="Root")
        payload = libdb.export_library_index(other_id)
    finally:
        reset_current_library_id(token)
    assert payload["format"] == "sd-image-sorter-library-export-v1"
    assert payload["library"]["id"] == other_id
    assert payload["image_count"] >= 1
    assert any(img["path"].endswith("lib-export-a.png") for img in payload["images"])
    assert any((r.get("path") or "").endswith("lib-export-root") for r in payload["roots"])


def test_library_roots_are_scoped_per_library(test_db):
    libdb.ensure_default_library()
    other = libdb.create_library("Roots B")
    other_id = other["id"]

    token = set_current_library_id(MAIN_LIBRARY_ID)
    try:
        db.add_library_root("L:/Pics/MainOnly", label="Main")
    finally:
        reset_current_library_id(token)

    token = set_current_library_id(other_id)
    try:
        db.add_library_root("L:/Pics/OtherOnly", label="Other")
        # Same path can exist in two libraries after multi-library roots.
        db.add_library_root("L:/Pics/Shared", label="Shared B")
        other_roots = db.list_library_roots()
    finally:
        reset_current_library_id(token)

    token = set_current_library_id(MAIN_LIBRARY_ID)
    try:
        db.add_library_root("L:/Pics/Shared", label="Shared A")
        main_roots = db.list_library_roots()
    finally:
        reset_current_library_id(token)

    main_paths = {r["path"] for r in main_roots}
    other_paths = {r["path"] for r in other_roots}
    assert "L:/Pics/MainOnly" in main_paths
    assert "L:/Pics/OtherOnly" not in main_paths
    assert "L:/Pics/OtherOnly" in other_paths
    assert "L:/Pics/MainOnly" not in other_paths
    assert "L:/Pics/Shared" in main_paths
    assert "L:/Pics/Shared" in other_paths
