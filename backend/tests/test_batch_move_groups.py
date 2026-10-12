"""V4 sort by condition with several rules: one batch-move run, several folders.

POST /api/batch-move takes an optional ``groups`` list (each: image ids, a
destination folder, an optional split). The whole list is ONE run: one run
token, one progress, one undo that puts every group back. An image listed in
more than one group goes with the first (the page decides that already; the
backend holds to it). A request without ``groups`` behaves exactly as before.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import BackgroundTasks, HTTPException
from pydantic import ValidationError

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


def _library(
    test_db, tmp_path: Path, count: int, generator: str = "nai"
) -> tuple[list[int], list[Path]]:
    ids, paths = [], []
    for n in range(count):
        path = _png(tmp_path / "src" / f"{n}.png", "white" if n % 2 else "black")
        ids.append(
            test_db.add_image(
                path=str(path),
                filename=path.name,
                generator=generator,
                metadata_json="{}",
            )
        )
        paths.append(path)
    return ids, paths


def _groups(*pairs) -> list[dict]:
    return [
        {"image_ids": ids, "destination_folder": str(folder), "split_by": split}
        for ids, folder, split in pairs
    ]


def test_several_groups_go_to_their_own_folders_in_one_run(svc, test_db, tmp_path):
    ids, paths = _library(test_db, tmp_path, 5)
    first, second = tmp_path / "keep", tmp_path / "best"

    started = _run(
        svc,
        ss.BatchMoveRequest(
            image_ids=ids[:4],
            destination_folder=str(first),
            groups=_groups((ids[:2], first, None), (ids[2:4], second, "generator")),
        ),
    )

    assert started["total"] == 4
    assert started["groups"] == 2
    assert (first / "0.png").exists() and (first / "1.png").exists()
    assert (second / "nai" / "2.png").exists() and (second / "nai" / "3.png").exists()
    assert paths[4].exists()
    progress = svc.get_batch_move_progress()
    assert progress["status"] == "done"
    assert progress["moved"] == 4
    assert progress["run_token"] == started["run_token"]
    assert test_db.get_image_by_id(ids[3])["path"] == str(second / "nai" / "3.png")


def test_one_undo_puts_every_group_back(svc, test_db, tmp_path):
    ids, paths = _library(test_db, tmp_path, 4)
    first, second = tmp_path / "keep", tmp_path / "best"
    token = _run(
        svc,
        ss.BatchMoveRequest(
            image_ids=ids,
            destination_folder=str(first),
            groups=_groups((ids[:2], first, None), (ids[2:], second, None)),
        ),
    )["run_token"]

    started = _undo(svc, token)

    assert started["total"] == 4
    for image_id, path in zip(ids, paths):
        assert path.exists()
        assert test_db.get_image_by_id(image_id)["path"] == str(path)
    assert not any(first.glob("*.png")) and not any(second.glob("*.png"))


def test_an_image_in_two_groups_goes_with_the_first(svc, test_db, tmp_path):
    ids, _paths = _library(test_db, tmp_path, 2)
    first, second = tmp_path / "keep", tmp_path / "best"

    started = _run(
        svc,
        ss.BatchMoveRequest(
            image_ids=ids,
            destination_folder=str(first),
            groups=_groups(([ids[0]], first, None), ([ids[0], ids[1]], second, None)),
        ),
    )

    assert started["total"] == 2
    assert (first / "0.png").exists()
    assert (second / "1.png").exists() and not (second / "0.png").exists()


def test_a_copy_run_by_groups_undoes_by_deleting_every_copy(svc, test_db, tmp_path):
    ids, paths = _library(test_db, tmp_path, 2)
    first, second = tmp_path / "keep", tmp_path / "best"
    token = _run(
        svc,
        ss.BatchMoveRequest(
            image_ids=ids,
            destination_folder=str(first),
            operation="copy",
            groups=_groups(([ids[0]], first, None), ([ids[1]], second, None)),
        ),
    )["run_token"]
    assert (first / "0.png").exists() and (second / "1.png").exists()
    assert all(path.exists() for path in paths)

    _undo(svc, token)

    assert not (first / "0.png").exists() and not (second / "1.png").exists()
    assert all(path.exists() for path in paths)


def test_a_bad_group_folder_is_refused_before_anything_moves(svc, test_db, tmp_path):
    ids, paths = _library(test_db, tmp_path, 2)
    request = ss.BatchMoveRequest(
        image_ids=ids,
        destination_folder=str(tmp_path / "keep"),
        groups=_groups(([ids[0]], tmp_path / "keep", None), ([ids[1]], "", None)),
    )
    with pytest.raises(HTTPException) as refused:
        _run(svc, request)
    assert refused.value.status_code == 400
    assert all(path.exists() for path in paths)


def test_groups_are_checked_like_the_rest_of_the_request():
    with pytest.raises(ValidationError):
        ss.BatchMoveRequest(
            destination_folder="D:/x",
            groups=[{"image_ids": [], "destination_folder": "D:/x"}],
        )
    with pytest.raises(ValidationError):
        ss.BatchMoveRequest(
            destination_folder="D:/x",
            groups=[
                {"image_ids": [1], "destination_folder": "D:/x", "split_by": "moon"}
            ],
        )
    # groups alone name the images: no filter is needed
    assert ss.BatchMoveRequest(
        destination_folder="D:/x",
        groups=[{"image_ids": [1], "destination_folder": "D:/x"}],
    ).groups


def test_a_request_without_groups_is_unchanged(svc, test_db, tmp_path):
    ids, _paths = _library(test_db, tmp_path, 2)
    dest = tmp_path / "dest"

    started = _run(
        svc,
        ss.BatchMoveRequest(
            image_ids=ids, destination_folder=str(dest), split_by="generator"
        ),
    )

    assert started["total"] == 2
    assert "groups" not in started
    assert (dest / "nai" / "0.png").exists() and (dest / "nai" / "1.png").exists()
