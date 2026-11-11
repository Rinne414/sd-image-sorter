"""The recent move and copy runs: listed newest first, so one can be undone later."""

from __future__ import annotations

import os
import time

import pytest

from services.sorting import move_journal, move_runs


@pytest.fixture()
def journals(tmp_path, monkeypatch):
    folder = tmp_path / "batch-move-runs"
    monkeypatch.setattr(move_journal, "journal_dir", lambda: folder)
    return folder


def _run(tmp_path, operation, destination, count, *, age, unfinished=0):
    token = move_journal.new_token()
    journal = move_journal.RunJournal(token, operation, destination)
    for n in range(count + unfinished):
        source = tmp_path / f"{token[:6]}-from-{n}.png"
        source.write_bytes(b"x")
        target = tmp_path / f"{token[:6]}-{n}.png"
        target.write_bytes(b"x")
        step = journal.intend(n + 1, str(source), destination)
        if n < count:
            journal.record(n + 1, str(source), str(target), step)
    journal.close()
    stamp = time.time() - age
    os.utime(move_journal.journal_dir() / f"{token}.jsonl", (stamp, stamp))
    return token


def test_runs_are_listed_newest_first_with_what_a_person_recognises(journals, tmp_path):
    older = _run(tmp_path, "move", "D:/sorted/keep", 3, age=600)
    newer = _run(tmp_path, "copy", "D:/sorted/post", 2, age=10)
    move_journal.mark_undone(older)

    listed = move_runs.list_runs()

    assert listed["total"] == 2
    assert [run["run_token"] for run in listed["runs"]] == [newer, older]
    first, second = listed["runs"]
    assert (
        first["operation"],
        first["destination"],
        first["files"],
        first["undone"],
    ) == (
        "copy",
        "D:/sorted/post",
        2,
        False,
    )
    assert (second["operation"], second["files"], second["undone"]) == ("move", 3, True)
    assert isinstance(first["started_at"], float)


def test_a_run_cut_short_says_how_many_files_it_never_finished(journals, tmp_path):
    _run(tmp_path, "move", "D:/sorted", 2, age=5, unfinished=1)

    (run,) = move_runs.list_runs()["runs"]

    assert run["files"] == 2 and run["interrupted"] == 1


def test_paging_and_no_runs_at_all(journals, tmp_path):
    assert move_runs.list_runs() == {"runs": [], "total": 0}
    tokens = [_run(tmp_path, "move", "D:/x", 1, age=100 - n) for n in range(5)]

    page = move_runs.list_runs(limit=2, offset=2)

    assert page["total"] == 5
    assert [run["run_token"] for run in page["runs"]] == list(reversed(tokens))[2:4]


def test_the_endpoint_lists_them(journals, tmp_path, test_client):
    token = _run(tmp_path, "move", "D:/sorted", 1, age=1)

    answer = test_client.get("/api/batch-move/runs", params={"limit": 5})

    assert answer.status_code == 200
    assert answer.json()["runs"][0]["run_token"] == token
