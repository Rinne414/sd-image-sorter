"""Manual Sort says when it cannot keep its place on disk.

A session resumes after a restart only from its saved file. A write that
failed (disk full, a locked file) was only logged: sorting went on and the
user believed the session would come back.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image


def _isolated_sorting_module(monkeypatch, tmp_path: Path):
    import services.sorting_service as ss

    monkeypatch.setattr(ss, "SESSION_FILE", str(tmp_path / "session.json"))
    monkeypatch.setattr(ss, "LEGACY_SESSION_FILE", str(tmp_path / "legacy.json"))
    return ss


def _add_pictures(db, tmp_path: Path, count: int) -> None:
    for index in range(count):
        path = tmp_path / f"save_state_{index}.png"
        Image.new("RGB", (8, 8), (index * 40, 90, 120)).save(path)
        db.add_image(
            path=str(path), filename=path.name, generator="unknown", metadata_json="{}"
        )


def test_a_session_whose_place_could_not_be_written_says_so(
    test_client, tmp_path, monkeypatch
):
    ss = _isolated_sorting_module(monkeypatch, tmp_path)
    _add_pictures(test_client.test_db, tmp_path, 3)
    real_write = ss.write_persisted_session

    def disk_full(_path, _data):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(ss, "write_persisted_session", disk_full)
    started = test_client.post("/api/sort/start?generators=unknown")
    assert started.status_code == 200, started.text
    assert started.json()["session_saved"] is False
    assert test_client.get("/api/sort/current").json()["session_saved"] is False

    monkeypatch.setattr(ss, "write_persisted_session", real_write)
    skipped = test_client.post("/api/sort/action?action=skip")

    assert skipped.status_code == 200, skipped.text
    assert skipped.json()["session_saved"] is True
    assert (tmp_path / "session.json").exists()


def test_a_session_written_to_disk_says_it_was_saved(
    test_client, tmp_path, monkeypatch
):
    _isolated_sorting_module(monkeypatch, tmp_path)
    _add_pictures(test_client.test_db, tmp_path, 2)

    started = test_client.post("/api/sort/start?generators=unknown")
    folders = test_client.post(
        "/api/sort/set-folders", json={"folders": {"w": str(tmp_path / "top")}}
    )

    assert started.json()["session_saved"] is True
    assert folders.json()["session_saved"] is True
    assert (tmp_path / "session.json").exists()
