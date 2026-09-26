"""V4 Sort by condition: a run's journal survives a power loss in the middle of a file.

Each file gets an "intent" line (where it comes from, where it goes, the
operation) that is on disk before the file is touched, and a "done" line
(where it went, size and time) that is on disk after. An undo that finds an
intent without its done line looks at the disk: the file goes back only when
it is at the destination and not at the source; anything else is named with
the reason and left alone. Journals written before intent lines existed
(every file line is a done line) still undo.
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import pytest

import services.sorting_service as ss
from services.sorting import move_journal
from tests.test_batch_move_undo import _library, _run, _undo, svc  # noqa: F401


class PowerLoss(BaseException):
    """Stops the run the way a power cut does: nothing after this line runs."""


def _journal(tmp_path: Path, token: str) -> list[dict]:
    path = tmp_path / "runs" / f"{token}.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def _crash_run(svc, request) -> str:
    """Start a run that dies part-way; the token of its journal."""
    with pytest.raises(PowerLoss):
        _run(svc, request)
    runs = list((move_journal.journal_dir()).glob("*.jsonl"))
    assert len(runs) == 1
    return runs[0].stem


def _undo_after_restart(token: str) -> dict:
    """The app starts again after the crash and the user undoes the run."""
    fresh = ss.SortingService()
    _undo(fresh, token)
    return fresh.get_batch_move_progress()


def _reasons(progress: dict) -> dict:
    return {item["filename"]: item["error"] for item in progress["error_items"]}


def test_the_intent_is_on_disk_before_the_file_moves_and_done_after(
    svc, test_db, tmp_path, monkeypatch
):
    ids, paths = _library(test_db, tmp_path, 2)
    dest = tmp_path / "dest"
    synced: list[list[dict]] = []
    real_fsync = os.fsync

    def fsync(fd: int) -> None:
        real_fsync(fd)
        runs = list((tmp_path / "runs").glob("*.jsonl"))
        if runs:
            synced.append(_journal(tmp_path, runs[0].stem))

    moves_seen: list[list[dict]] = []
    real_move = ss.move_image

    def move_image(image_id, destination_folder, image_path):
        moves_seen.append(synced[-1] if synced else [])
        return real_move(image_id, destination_folder, image_path)

    monkeypatch.setattr(os, "fsync", fsync)
    monkeypatch.setattr(ss, "move_image", move_image)

    token = _run(svc, ss.BatchMoveRequest(image_ids=ids, destination_folder=str(dest)))[
        "run_token"
    ]

    # When each file moved, the last thing flushed to disk was its intent.
    for image_id, path, seen in zip(ids, paths, moves_seen):
        last = seen[-1]
        assert last["phase"] == "intent"
        assert last["image_id"] == image_id
        assert last["source"] == str(path)
        assert last["destination"] == str(dest)
        assert last["operation"] == "move"
    lines = _journal(tmp_path, token)
    assert synced[-1] == lines
    done = [line for line in lines if line.get("phase") == "done"]
    assert [line["target"] for line in done] == [str(dest / p.name) for p in paths]
    assert all("size" in line and "mtime_ns" in line for line in done)


def test_a_crash_after_the_move_but_before_done_is_still_undone(
    svc, test_db, tmp_path, monkeypatch
):
    ids, paths = _library(test_db, tmp_path, 3)
    dest = tmp_path / "dest"
    real_record = move_journal.RunJournal.record
    written: list[int] = []

    def record(self, image_id, source, target, step=None):
        if written:
            raise PowerLoss()  # the second file moved, then the power went
        written.append(image_id)
        return real_record(self, image_id, source, target, step)

    monkeypatch.setattr(move_journal.RunJournal, "record", record)
    token = _crash_run(
        svc, ss.BatchMoveRequest(image_ids=ids, destination_folder=str(dest))
    )
    assert (dest / "1.png").exists() and not paths[1].exists()

    progress = _undo_after_restart(token)

    assert progress["errors"] == 0
    assert progress["moved"] == 2
    for image_id, path in zip(ids[:2], paths[:2]):
        assert path.exists()
        assert test_db.get_image_by_id(image_id)["path"] == str(path)
    assert paths[2].exists()
    assert not any(dest.glob("*.png"))


def test_a_crash_before_the_library_learned_the_new_place_is_undone(
    svc, test_db, tmp_path, monkeypatch
):
    ids, paths = _library(test_db, tmp_path, 1)
    dest = tmp_path / "dest"

    def move_image(image_id, destination_folder, image_path):
        os.makedirs(destination_folder, exist_ok=True)
        shutil.move(image_path, os.path.join(destination_folder, "0.png"))
        raise PowerLoss()  # the file moved; the database row never changed

    monkeypatch.setattr(ss, "move_image", move_image)
    token = _crash_run(
        svc, ss.BatchMoveRequest(image_ids=ids, destination_folder=str(dest))
    )

    progress = _undo_after_restart(token)

    assert progress["errors"] == 0
    assert progress["moved"] == 1
    assert paths[0].exists() and not (dest / "0.png").exists()
    assert test_db.get_image_by_id(ids[0])["path"] == str(paths[0])


def test_a_crash_before_the_file_moved_leaves_it_and_says_so(
    svc, test_db, tmp_path, monkeypatch
):
    ids, paths = _library(test_db, tmp_path, 1)

    def move_image(image_id, destination_folder, image_path):
        raise PowerLoss()

    monkeypatch.setattr(ss, "move_image", move_image)
    token = _crash_run(
        svc,
        ss.BatchMoveRequest(image_ids=ids, destination_folder=str(tmp_path / "dest")),
    )

    progress = _undo_after_restart(token)

    assert progress["moved"] == 0
    assert "still in its original place" in _reasons(progress)["0.png"]
    assert paths[0].exists()
    assert test_db.get_image_by_id(ids[0])["path"] == str(paths[0])


def test_a_file_in_both_places_is_left_for_a_look_at_the_disk(
    svc, test_db, tmp_path, monkeypatch
):
    ids, paths = _library(test_db, tmp_path, 1)
    dest = tmp_path / "dest"

    def move_image(image_id, destination_folder, image_path):
        os.makedirs(destination_folder, exist_ok=True)
        shutil.copy2(image_path, os.path.join(destination_folder, "0.png"))
        raise PowerLoss()  # a cross-drive move copied, then the power went

    monkeypatch.setattr(ss, "move_image", move_image)
    token = _crash_run(
        svc, ss.BatchMoveRequest(image_ids=ids, destination_folder=str(dest))
    )

    progress = _undo_after_restart(token)

    assert progress["moved"] == 0
    assert "check the disk" in _reasons(progress)["0.png"]
    assert paths[0].exists() and (dest / "0.png").exists()


def test_another_file_under_its_name_is_not_taken_for_it(
    svc, test_db, tmp_path, monkeypatch
):
    ids, paths = _library(test_db, tmp_path, 1)
    dest = tmp_path / "dest"
    # Someone else's 0.png (another size) was already in the destination, so
    # the run's file went in as 0_1.png; the power went before the library
    # learned the new name.
    from PIL import Image

    theirs = dest / "0.png"
    dest.mkdir()
    Image.new("RGB", (64, 64), color="blue").save(theirs)
    assert theirs.stat().st_size != paths[0].stat().st_size

    def move_image(image_id, destination_folder, image_path):
        shutil.move(image_path, os.path.join(destination_folder, "0_1.png"))
        raise PowerLoss()

    monkeypatch.setattr(ss, "move_image", move_image)
    token = _crash_run(
        svc, ss.BatchMoveRequest(image_ids=ids, destination_folder=str(dest))
    )

    progress = _undo_after_restart(token)

    assert progress["moved"] == 0
    assert "check the disk" in _reasons(progress)["0.png"]
    assert theirs.exists() and (dest / "0_1.png").exists()
    assert not paths[0].exists()


def test_a_copy_cut_short_is_named_and_its_copy_kept(
    svc, test_db, tmp_path, monkeypatch
):
    ids, paths = _library(test_db, tmp_path, 1)
    dest = tmp_path / "dest"
    real_copy = ss.copy_image

    def copy_image(**kwargs):
        real_copy(**kwargs)
        raise PowerLoss()

    monkeypatch.setattr(ss, "copy_image", copy_image)
    token = _crash_run(
        svc,
        ss.BatchMoveRequest(
            image_ids=ids, destination_folder=str(dest), operation="copy"
        ),
    )

    progress = _undo_after_restart(token)

    assert progress["moved"] == 0
    assert "copying" in _reasons(progress)["0.png"]
    assert (dest / "0.png").exists() and paths[0].exists()


def test_a_journal_written_before_intent_lines_existed_still_undoes(
    svc, test_db, tmp_path
):
    ids, paths = _library(test_db, tmp_path, 2)
    dest = tmp_path / "dest"
    dest.mkdir()
    token = move_journal.new_token()
    lines = [
        {
            "kind": "run",
            "operation": "move",
            "destination": str(dest),
            "started_at": 1.0,
        }
    ]
    for image_id, path in zip(ids, paths):
        target = dest / path.name
        shutil.move(str(path), target)
        test_db.update_image_path(image_id, str(target))
        lines.append(
            {
                "kind": "file",
                "image_id": image_id,
                "source": str(path),
                "target": str(target),
                **move_journal.file_facts(str(target)),
            }
        )
    runs = tmp_path / "runs"
    runs.mkdir()
    (runs / f"{token}.jsonl").write_text(
        "".join(json.dumps(line) + "\n" for line in lines), encoding="utf-8"
    )

    progress = _undo_after_restart(token)

    assert progress["errors"] == 0
    assert progress["moved"] == 2
    for image_id, path in zip(ids, paths):
        assert path.exists()
        assert test_db.get_image_by_id(image_id)["path"] == str(path)
