"""A moved picture whose journal line could not be written still counts as moved."""

from __future__ import annotations

from pathlib import Path

from fastapi import BackgroundTasks

import services.sorting_service as ss
from services.sorting import move_journal


def _png(path: Path) -> Path:
    from PIL import Image

    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (16, 16), color="black").save(path)
    return path


def _drain(started_tasks: BackgroundTasks) -> None:
    for task in started_tasks.tasks:
        task.func()


def test_a_full_disk_on_the_journal_line_neither_fails_the_move_nor_its_undo(
    svc, test_db, tmp_path, monkeypatch
):
    src = tmp_path / "src"
    ids, paths = [], []
    for n in range(2):
        path = _png(src / f"{n}.png")
        ids.append(test_db.add_image(path=str(path), filename=path.name, generator="nai", metadata_json="{}"))
        paths.append(path)
    dest = tmp_path / "dest"

    real_record = move_journal.RunJournal.record

    def disk_full(self, *args, **kwargs):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(move_journal.RunJournal, "record", disk_full)
    tasks = BackgroundTasks()
    token = svc.batch_move_images(ss.BatchMoveRequest(image_ids=ids, destination_folder=str(dest)), tasks)["run_token"]
    _drain(tasks)

    progress = svc.get_batch_move_progress()
    assert progress["moved"] == 2
    assert progress["errors"] == 0
    assert (dest / "0.png").exists() and (dest / "1.png").exists()

    # Undo still finds the pictures through the intent lines. (Only this one
    # patch is put back: the svc fixture keeps the journals in tmp_path.)
    monkeypatch.setattr(move_journal.RunJournal, "record", real_record)
    tasks = BackgroundTasks()
    svc.undo_batch_move(ss.BatchMoveUndoRequest(run_token=token), tasks)
    _drain(tasks)
    assert paths[0].exists() and paths[1].exists()
