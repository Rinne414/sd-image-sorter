"""Pictures Auto-Separate or Manual Sort already sorted are remembered.

The owner's workflow is "auto-sort first, hand-sort the rest". A walkthrough
found that after Auto-Separate copied 18 of 40 pictures, Manual Sort still
counted and queued all 40: in copy mode the originals stay where they were,
and in move mode the library row is only re-pointed. Migration 051 keeps one
``sorted_images`` row per picture a sort actually put somewhere; Manual Sort
can leave those pictures out, and its setup count says how many it left out.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi import BackgroundTasks

import database as db
import db_sorted_marks as marks
import migrations
import services.sorting_service as ss
from services.sorting_models import FolderConfig


@pytest.fixture
def svc(tmp_path, monkeypatch):
    """A fresh SortingService with its persisted-session files redirected."""
    monkeypatch.setattr(
        ss, "SESSION_FILE", str(tmp_path / "session.json"), raising=False
    )
    monkeypatch.setattr(
        ss, "LEGACY_SESSION_FILE", str(tmp_path / "legacy.json"), raising=False
    )
    return ss.SortingService()


def _png(path: Path, color: str = "red") -> Path:
    from PIL import Image

    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (16, 16), color=color).save(path)
    return path


def _add(test_db, path: Path) -> int:
    return test_db.add_image(
        path=str(path), filename=path.name, generator="unknown", metadata_json="{}"
    )


def _library(test_db, tmp_path: Path, count: int) -> list[int]:
    return [
        _add(test_db, _png(tmp_path / "library" / f"{index:05d}.png"))
        for index in range(count)
    ]


def _run_batch(svc, tmp_path: Path, operation: str) -> Path:
    destination = tmp_path / f"auto-{operation}"
    background = BackgroundTasks()
    svc.batch_move_images(
        ss.BatchMoveRequest(
            destination_folder=str(destination),
            generators=["unknown"],
            operation=operation,
        ),
        background,
    )
    background.tasks[0].func()
    assert svc.get_batch_move_progress()["status"] == "done"
    return destination


def _start_slot_session(svc, tmp_path: Path, operation: str, **scope) -> dict:
    result = svc.start_sort_session(
        generators=["unknown"], operation_mode=operation, replace_existing=True, **scope
    )
    svc.set_sort_folders(FolderConfig(folders={"a": str(tmp_path / "hand-sorted")}))
    return result


# ---------------------------------------------------------------------------
# Migration 051
# ---------------------------------------------------------------------------


@pytest.fixture
def v50_database(tmp_path, monkeypatch):
    """A database built by the real migration chain, stopped at version 50."""
    all_migrations = migrations.get_migrations()
    assert all_migrations[-1].version >= 51
    monkeypatch.setattr(db, "DATABASE_PATH", str(tmp_path / "v50.db"))
    monkeypatch.setattr(db, "_pragmas_initialized", set())
    monkeypatch.setattr(
        migrations,
        "get_migrations",
        lambda: [m for m in all_migrations if m.version <= 50],
    )
    db.init_db()
    monkeypatch.setattr(migrations, "get_migrations", lambda: all_migrations)
    monkeypatch.setattr(db, "_pragmas_initialized", set())
    return db


def _table_names(conn: sqlite3.Connection) -> set[str]:
    return {
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }


def test_fresh_database_has_one_mark_row_per_picture(test_db):
    with test_db.get_db() as conn:
        columns = {
            row[1]: row for row in conn.execute("PRAGMA table_info(sorted_images)")
        }
        assert set(columns) == {"image_id", "source", "operation", "sorted_at"}
        assert columns["image_id"][5] == 1, "image_id is the primary key"
        foreign_keys = conn.execute("PRAGMA foreign_key_list(sorted_images)").fetchall()
        assert [(row[2], row[3], row[4], row[6]) for row in foreign_keys] == [
            ("images", "image_id", "id", "CASCADE")
        ]


def test_marks_follow_their_picture(test_db, tmp_path):
    first, second = _library(test_db, tmp_path, 2)
    marks.mark_image_sorted(first, marks.SOURCE_AUTO_SEPARATE, "copy")
    marks.mark_image_sorted(second, marks.SOURCE_MANUAL_SORT, "move")

    test_db.delete_image(first)

    assert marks.get_sorted_mark(first) is None
    assert marks.sorted_ids_among([first, second]) == {second}


def test_upgrade_from_v50_adds_the_table_and_keeps_pictures(v50_database):
    with v50_database.get_db() as conn:
        assert "sorted_images" not in _table_names(conn)
        conn.execute(
            "INSERT INTO images (id, path, filename) VALUES (7, '/lib/g.png', 'g.png')"
        )

    v50_database.init_db()

    with v50_database.get_db() as conn:
        assert "sorted_images" in _table_names(conn)
        assert conn.execute("SELECT id FROM images WHERE id = 7").fetchone() is not None
    marks.mark_image_sorted(7, marks.SOURCE_MANUAL_SORT, "copy")
    assert marks.get_sorted_mark(7)["operation"] == "copy"


def test_migration_051_is_idempotent(test_db, tmp_path):
    (image_id,) = _library(test_db, tmp_path, 1)
    marks.mark_image_sorted(image_id, marks.SOURCE_AUTO_SEPARATE, "move")
    migration = next(item for item in migrations.get_migrations() if item.version == 51)
    with test_db.get_db() as conn:
        migration.apply(conn)
    assert marks.get_sorted_mark(image_id)["source"] == marks.SOURCE_AUTO_SEPARATE


# ---------------------------------------------------------------------------
# Auto-Separate writes the record
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("operation", ["copy", "move"])
def test_auto_separate_marks_each_picture_it_put_somewhere(
    test_db, svc, tmp_path, operation
):
    good = _library(test_db, tmp_path, 2)
    broken_path = tmp_path / "library" / "broken.png"
    broken_path.write_bytes(b"not a png")
    broken = _add(test_db, broken_path)

    _run_batch(svc, tmp_path, operation)

    for image_id in good:
        mark = marks.get_sorted_mark(image_id)
        assert mark is not None, f"picture {image_id} was {operation}d but not marked"
        assert mark["source"] == marks.SOURCE_AUTO_SEPARATE
        assert mark["operation"] == operation
    assert marks.get_sorted_mark(broken) is None, "a failed picture is not sorted"


# ---------------------------------------------------------------------------
# Manual Sort writes the record; undo takes it back
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("operation", ["copy", "move"])
def test_manual_sort_marks_and_undo_clears(test_db, svc, tmp_path, operation):
    (image_id,) = _library(test_db, tmp_path, 1)
    _start_slot_session(svc, tmp_path, operation)

    svc.sort_action("move", "a")
    mark = marks.get_sorted_mark(image_id)
    assert mark is not None
    assert (mark["source"], mark["operation"]) == (marks.SOURCE_MANUAL_SORT, operation)

    svc.sort_action("undo")
    assert marks.get_sorted_mark(image_id) is None

    svc.sort_action("redo")
    assert marks.get_sorted_mark(image_id)["source"] == marks.SOURCE_MANUAL_SORT


def test_manual_sort_skip_is_not_a_sort(test_db, svc, tmp_path):
    (image_id,) = _library(test_db, tmp_path, 1)
    _start_slot_session(svc, tmp_path, "copy")

    svc.sort_action("skip")

    assert marks.get_sorted_mark(image_id) is None


def test_undo_gives_back_the_auto_separate_mark_it_replaced(test_db, svc, tmp_path):
    (image_id,) = _library(test_db, tmp_path, 1)
    marks.mark_image_sorted(image_id, marks.SOURCE_AUTO_SEPARATE, "copy")
    _start_slot_session(svc, tmp_path, "copy", exclude_sorted=False)

    svc.sort_action("move", "a")
    assert marks.get_sorted_mark(image_id)["source"] == marks.SOURCE_MANUAL_SORT
    svc.sort_action("undo")

    mark = marks.get_sorted_mark(image_id)
    assert mark is not None, (
        "undoing the hand sort must not forget Auto-Separate's copy"
    )
    assert (mark["source"], mark["operation"]) == (marks.SOURCE_AUTO_SEPARATE, "copy")


# ---------------------------------------------------------------------------
# Manual Sort scope: leave sorted pictures out, and say how many
# ---------------------------------------------------------------------------


def test_auto_sort_then_hand_sort_the_rest(test_db, svc, tmp_path):
    """The walkthrough: Auto-Separate copied some, Manual Sort gets the rest."""
    copied = _library(test_db, tmp_path, 3)
    _run_batch(svc, tmp_path, "copy")
    rest = [
        _add(test_db, _png(tmp_path / "library" / f"rest-{n}.png")) for n in range(2)
    ]

    count = svc.count_sort_scope(generators=["unknown"])
    assert count == {"total": 5, "sorted": 3, "remaining": 2}

    started = _start_slot_session(svc, tmp_path, "copy", exclude_sorted=True)
    assert started["total_images"] == count["remaining"]
    assert started["excluded_sorted"] == 3
    assert sorted(svc.get_sort_session()["image_ids"]) == sorted(rest)
    assert not set(copied) & set(svc.get_sort_session()["image_ids"])


def test_sort_start_keeps_sorted_pictures_unless_asked(test_db, svc, tmp_path):
    ids = _library(test_db, tmp_path, 3)
    marks.mark_image_sorted(ids[0], marks.SOURCE_AUTO_SEPARATE, "move")

    started = _start_slot_session(svc, tmp_path, "copy")

    assert started["total_images"] == 3
    assert started["excluded_sorted"] == 0


def test_scope_count_and_start_routes_agree(test_client, tmp_path):
    test_db = test_client.test_db
    ids = _library(test_db, tmp_path, 4)
    marks.mark_image_sorted(ids[1], marks.SOURCE_MANUAL_SORT, "copy")
    marks.mark_image_sorted(ids[2], marks.SOURCE_AUTO_SEPARATE, "move")
    body = {"generators": ["unknown"], "folders": {}, "operation_mode": "copy"}

    counted = test_client.post("/api/sort/scope-count", json=body)
    assert counted.status_code == 200, counted.text
    assert counted.json() == {"total": 4, "sorted": 2, "remaining": 2}

    started = test_client.post(
        "/api/sort/start",
        json={**body, "exclude_sorted": True, "replace_existing": True},
    )
    assert started.status_code == 200, started.text
    assert started.json()["total_images"] == 2
    assert started.json()["excluded_sorted"] == 2

    by_query = test_client.post(
        "/api/sort/start?generators=unknown&exclude_sorted=true&replace_existing=true"
    )
    assert by_query.status_code == 200, by_query.text
    assert by_query.json()["total_images"] == 2


# ---------------------------------------------------------------------------
# Undo says what it undid (item 8)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("action", "operation"), [("move", "move"), ("move", "copy"), ("skip", "copy")]
)
def test_undo_names_the_picture_it_undid(test_db, svc, tmp_path, action, operation):
    _library(test_db, tmp_path, 2)
    _start_slot_session(svc, tmp_path, operation)
    shown = svc.get_current_sort_image()["image"]

    svc.sort_action(action, "a" if action == "move" else None)
    undone = svc.sort_action("undo")

    assert undone["status"] == "undone"
    assert undone["undone_action"] == action
    assert undone["undone_image_id"] == shown["id"]
    assert undone["undone_filename"] == shown["filename"]
    if action == "move":
        assert undone["undone_operation"] == operation
