"""V4 Sort tab, sort by condition: a batch move/copy of chosen images that can be undone.

- POST /api/batch-move accepts ``image_ids`` (the picks, or every match of a V4
  search resolved by the page) instead of filters.
- Every run records what it moved or copied (a journal under the state dir)
  and names itself with ``run_token``, in the start answer and the progress.
- POST /api/batch-move/undo puts each moved file back where it came from and
  removes each copy it made, but only while the file is still what the run
  left behind; everything it cannot restore is listed with the reason.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest
from fastapi import BackgroundTasks, HTTPException

import services.sorting_service as ss
from services.sorting import move_journal


def _png(path: Path, color: str = "white") -> Path:
    from PIL import Image

    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (16, 16), color=color).save(path)
    return path


@pytest.fixture
def svc(tmp_path, monkeypatch, test_db):
    monkeypatch.setattr(
        ss, "SESSION_FILE", str(tmp_path / "session.json"), raising=False
    )
    monkeypatch.setattr(
        ss, "LEGACY_SESSION_FILE", str(tmp_path / "legacy.json"), raising=False
    )
    monkeypatch.setattr(move_journal, "journal_dir", lambda: tmp_path / "runs")
    return ss.SortingService()


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


def _library(test_db, tmp_path: Path, count: int) -> tuple[list[int], list[Path]]:
    src = tmp_path / "src"
    ids, paths = [], []
    for n in range(count):
        path = _png(src / f"{n}.png", "white" if n % 2 else "black")
        image_id = test_db.add_image(
            path=str(path), filename=path.name, generator="nai", metadata_json="{}"
        )
        ids.append(image_id)
        paths.append(path)
    return ids, paths


def test_picked_images_move_split_by_generator_and_the_run_names_itself(
    svc, test_db, tmp_path
):
    ids, paths = _library(test_db, tmp_path, 3)
    dest = tmp_path / "dest"

    started = _run(
        svc,
        ss.BatchMoveRequest(
            image_ids=[ids[2], ids[0]],
            destination_folder=str(dest),
            split_by="generator",
        ),
    )

    assert started["total"] == 2
    token = started["run_token"]
    assert len(token) == 32
    assert (dest / "nai" / "0.png").exists() and (dest / "nai" / "2.png").exists()
    assert paths[1].exists()
    progress = svc.get_batch_move_progress()
    assert progress["status"] == "done"
    assert progress["moved"] == 2
    assert progress["run_token"] == token
    assert progress["run_kind"] == "sort"
    assert test_db.get_image_by_id(ids[0])["path"] == str(dest / "nai" / "0.png")


def test_undo_puts_every_moved_file_back(svc, test_db, tmp_path):
    ids, paths = _library(test_db, tmp_path, 3)
    dest = tmp_path / "dest"
    token = _run(svc, ss.BatchMoveRequest(image_ids=ids, destination_folder=str(dest)))[
        "run_token"
    ]

    started = _undo(svc, token)

    assert started["total"] == 3
    for image_id, path in zip(ids, paths):
        assert path.exists()
        assert test_db.get_image_by_id(image_id)["path"] == str(path)
    assert not any(dest.glob("*.png"))
    progress = svc.get_batch_move_progress()
    assert progress["status"] == "done"
    assert progress["run_kind"] == "undo"
    assert progress["moved"] == 3
    assert progress["errors"] == 0


def test_undo_restores_what_it_can_and_says_why_for_the_rest(svc, test_db, tmp_path):
    ids, paths = _library(test_db, tmp_path, 3)
    dest = tmp_path / "dest"
    token = _run(svc, ss.BatchMoveRequest(image_ids=ids, destination_folder=str(dest)))[
        "run_token"
    ]

    # 0 was moved on again since; 1's old place is taken by another file.
    elsewhere = tmp_path / "elsewhere" / "0.png"
    elsewhere.parent.mkdir()
    shutil.move(str(dest / "0.png"), elsewhere)
    test_db.update_image_path(ids[0], str(elsewhere))
    _png(paths[1], "red")

    _undo(svc, token)

    progress = svc.get_batch_move_progress()
    assert progress["moved"] == 1
    assert progress["errors"] == 2
    reasons = {item["filename"]: item["error"] for item in progress["error_items"]}
    assert set(reasons) == {"0.png", "1.png"}
    assert "moved again" in reasons["0.png"]
    assert "already" in reasons["1.png"]
    assert elsewhere.exists()
    assert (dest / "1.png").exists()
    assert paths[2].exists() and not (dest / "2.png").exists()


def test_undo_of_a_copy_removes_the_copies_it_made_and_keeps_a_changed_one(
    svc, test_db, tmp_path
):
    ids, paths = _library(test_db, tmp_path, 2)
    dest = tmp_path / "dest"
    token = _run(
        svc,
        ss.BatchMoveRequest(
            image_ids=ids, destination_folder=str(dest), operation="copy"
        ),
    )["run_token"]
    assert (dest / "0.png").exists() and (dest / "1.png").exists()
    _png(dest / "1.png", "green")
    os.utime(dest / "1.png", ns=(1, 1))

    _undo(svc, token)

    progress = svc.get_batch_move_progress()
    assert progress["moved"] == 1
    assert progress["errors"] == 1
    assert "changed" in progress["error_items"][0]["error"]
    assert not (dest / "0.png").exists()
    assert (dest / "1.png").exists()
    assert paths[0].exists() and paths[1].exists()


def test_a_run_is_undone_once_and_unknown_runs_are_refused(svc, test_db, tmp_path):
    ids, _ = _library(test_db, tmp_path, 1)
    token = _run(
        svc,
        ss.BatchMoveRequest(image_ids=ids, destination_folder=str(tmp_path / "dest")),
    )["run_token"]
    _undo(svc, token)

    with pytest.raises(HTTPException) as again:
        _undo(svc, token)
    assert again.value.status_code == 409
    with pytest.raises(HTTPException) as unknown:
        _undo(svc, "0" * 32)
    assert unknown.value.status_code == 404


def test_the_undo_endpoint_answers_through_the_router(
    test_client, tmp_path, monkeypatch
):
    import database as db
    from routers.sorting import set_sorting_service

    monkeypatch.setattr(move_journal, "journal_dir", lambda: tmp_path / "runs")
    set_sorting_service(ss.SortingService())
    path = _png(tmp_path / "src" / "a.png")
    image_id = db.add_image(
        path=str(path), filename="a.png", generator="nai", metadata_json="{}"
    )

    started = test_client.post(
        "/api/batch-move",
        json={"image_ids": [image_id], "destination_folder": str(tmp_path / "dest")},
    )
    assert started.status_code == 200, started.text
    token = started.json()["run_token"]
    assert test_client.get("/api/batch-move/progress").json()["run_token"] == token

    undone = test_client.post("/api/batch-move/undo", json={"run_token": token})
    assert undone.status_code == 200, undone.text
    assert path.exists()
    assert (
        test_client.post(
            "/api/batch-move/undo", json={"run_token": "not-a-token"}
        ).status_code
        == 400
    )
    set_sorting_service(ss.SortingService())
