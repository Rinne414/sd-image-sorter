"""An undo that left some files can be run again once their cause is gone."""

from __future__ import annotations

from pathlib import Path

from fastapi import BackgroundTasks

import services.sorting_service as ss


def _png(path: Path, color: str = "white") -> Path:
    from PIL import Image

    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (16, 16), color=color).save(path)
    return path


def _run(svc, request) -> dict:
    tasks = BackgroundTasks()
    started = svc.batch_move_images(request, tasks)
    for task in tasks.tasks:
        task.func()
    return started


def _undo(svc, token: str) -> dict:
    tasks = BackgroundTasks()
    started = svc.undo_batch_move(ss.BatchMoveUndoRequest(run_token=token), tasks)
    for task in tasks.tasks:
        task.func()
    return started


def test_an_undo_that_left_a_file_runs_again_after_its_place_is_free(svc, test_db, tmp_path):
    src = tmp_path / "src"
    ids, paths = [], []
    for n in range(2):
        path = _png(src / f"{n}.png", "black")
        ids.append(test_db.add_image(path=str(path), filename=path.name, generator="nai", metadata_json="{}"))
        paths.append(path)
    dest = tmp_path / "dest"
    token = _run(svc, ss.BatchMoveRequest(image_ids=ids, destination_folder=str(dest)))["run_token"]

    # 1's old place is taken, so the first undo leaves it in dest.
    blocker = _png(paths[1], "red")
    _undo(svc, token)
    progress = svc.get_batch_move_progress()
    assert progress["moved"] == 1 and progress["errors"] == 1
    assert (dest / "1.png").exists()

    # The user clears the place; the undo runs again and puts 1 back.
    blocker.unlink()
    _undo(svc, token)
    progress = svc.get_batch_move_progress()
    assert progress["status"] == "done"
    assert progress["errors"] == 0
    assert paths[0].exists() and paths[1].exists()
    assert not (dest / "1.png").exists()
