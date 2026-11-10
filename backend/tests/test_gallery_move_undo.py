"""A move or copy started from the gallery selection can be undone.

The gallery's job (POST /api/move/start) writes the same journal a sort run
does and names it with ``run_token`` in its final progress, so the page can
offer Undo, which goes through POST /api/batch-move/undo.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import BackgroundTasks

import services.sorting_service as ss
from services.sorting import move_journal


def _png(path: Path, color: str = "white") -> Path:
    from PIL import Image

    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (16, 16), color=color).save(path)
    return path


def _library(test_db, tmp_path: Path, count: int) -> tuple[list[int], list[Path]]:
    ids, paths = [], []
    for n in range(count):
        path = _png(tmp_path / "src" / f"{n}.png", "white" if n % 2 else "black")
        ids.append(
            test_db.add_image(
                path=str(path), filename=path.name, generator="nai", metadata_json="{}"
            )
        )
        paths.append(path)
    return ids, paths


def _move(svc, ids, dest: Path, operation: str = "move") -> dict:
    tasks = BackgroundTasks()
    svc.start_move_job(
        ss.MoveRequest(
            image_ids=ids, destination_folder=str(dest), operation=operation
        ),
        tasks,
    )
    for task in tasks.tasks:
        task.func()
    return svc.get_move_progress()


def _undo(svc, token: str) -> dict:
    tasks = BackgroundTasks()
    svc.undo_batch_move(ss.BatchMoveUndoRequest(run_token=token), tasks)
    for task in tasks.tasks:
        task.func()
    return svc.get_batch_move_progress()


def test_a_gallery_move_names_its_run_and_undo_puts_every_file_back(
    svc, test_db, tmp_path
):
    ids, paths = _library(test_db, tmp_path, 3)
    dest = tmp_path / "dest"

    progress = _move(svc, ids, dest)

    assert progress["status"] == "done"
    assert progress["moved"] == 3
    token = progress["run_token"]
    assert len(token) == 32
    assert len(move_journal.read_run(token)["files"]) == 3
    assert not any(path.exists() for path in paths)

    undone = _undo(svc, token)

    assert undone["status"] == "done"
    assert undone["moved"] == 3
    assert undone["errors"] == 0
    for image_id, path in zip(ids, paths):
        assert path.exists()
        assert test_db.get_image_by_id(image_id)["path"] == str(path)
    assert not any(dest.glob("*.png"))


def test_undo_of_a_gallery_copy_removes_the_copies_and_keeps_the_originals(
    svc, test_db, tmp_path
):
    ids, paths = _library(test_db, tmp_path, 2)
    dest = tmp_path / "dest"

    progress = _move(svc, ids, dest, operation="copy")

    assert len(list(dest.glob("*.png"))) == 2
    undone = _undo(svc, progress["run_token"])

    assert undone["errors"] == 0
    assert not any(dest.glob("*.png"))
    assert all(path.exists() for path in paths)


def test_a_run_that_moved_nothing_offers_no_undo(svc, test_db, tmp_path):
    ids, paths = _library(test_db, tmp_path, 1)
    paths[0].unlink()

    progress = _move(svc, ids, tmp_path / "dest")

    assert progress["moved"] == 0
    assert progress["run_token"] is None


def test_the_move_still_runs_when_the_journal_cannot_be_written(
    svc, test_db, tmp_path, monkeypatch
):
    ids, _paths = _library(test_db, tmp_path, 1)
    dest = tmp_path / "dest"

    def refuse(*_args, **_kwargs):
        raise OSError("read-only state folder")

    monkeypatch.setattr(move_journal, "RunJournal", refuse)

    progress = _move(svc, ids, dest)

    assert progress["moved"] == 1
    assert progress["run_token"] is None
    assert (dest / "0.png").exists()
