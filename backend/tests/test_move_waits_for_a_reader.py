"""A move waits a moment for a program that is still reading the file.

Windows refuses to rename or delete a file that another handle holds open
without delete sharing, and that is how Python, Pillow and antivirus scanners
open files. This server holds such a handle itself while it sends a picture to
the browser or builds its thumbnail, so a sort key pressed the moment a picture
appeared failed with "in use by another program" (seen in the V Opus sort E2E
on 2026-10-18). Those handles close within moments; a refusal that outlasts
the wait is still reported, and other refusals are reported at once.
"""

from __future__ import annotations

import errno
import os
import threading
from pathlib import Path

import pytest

import image_manager

windows_only = pytest.mark.skipif(
    os.name != "nt", reason="sharing violations exist only on Windows"
)

READER_HOLDS_SECONDS = 0.3


def _picture(tmp_path: Path, folder: str = "source") -> Path:
    source = tmp_path / folder / "picture.png"
    source.parent.mkdir()
    source.write_bytes(b"picture bytes")
    return source


def _read_for_a_moment(path: Path) -> threading.Thread:
    """Hold the file open the way the server does while it streams it."""
    handle = open(path, "rb")
    closer = threading.Timer(READER_HOLDS_SECONDS, handle.close)
    closer.start()
    return closer


@windows_only
def test_a_move_waits_for_a_reader_to_finish(tmp_path: Path) -> None:
    source = _picture(tmp_path)
    destination = tmp_path / "to-d" / "picture.png"
    destination.parent.mkdir()
    closer = _read_for_a_moment(source)

    try:
        image_manager._move_file_atomically(str(source), str(destination))
    finally:
        closer.join()

    assert not source.exists()
    assert destination.read_bytes() == b"picture bytes"


@windows_only
def test_a_cross_drive_move_waits_for_a_reader_before_removing_the_source(
    tmp_path: Path, monkeypatch
) -> None:
    source = _picture(tmp_path, "drive-a")
    destination = tmp_path / "drive-b" / "picture.png"
    destination.parent.mkdir()
    real_replace = os.replace

    def other_drive(src, dst, *args, **kwargs):
        if os.path.abspath(str(src)) == os.path.abspath(str(source)):
            raise OSError(errno.EXDEV, "Invalid cross-device link")
        return real_replace(src, dst, *args, **kwargs)

    monkeypatch.setattr(image_manager.os, "replace", other_drive)
    closer = _read_for_a_moment(source)

    try:
        image_manager._move_file_atomically(str(source), str(destination))
    finally:
        closer.join()

    assert not source.exists()
    assert destination.read_bytes() == b"picture bytes"


@windows_only
def test_a_file_held_past_the_wait_is_still_refused(
    tmp_path: Path, monkeypatch
) -> None:
    source = _picture(tmp_path)
    destination = tmp_path / "to-d" / "picture.png"
    destination.parent.mkdir()
    monkeypatch.setattr(image_manager, "_SHARED_FILE_RETRY_DELAYS", (0.01, 0.01))

    with open(source, "rb"):
        with pytest.raises(PermissionError) as refused:
            image_manager._move_file_atomically(str(source), str(destination))

    assert refused.value.winerror == 32
    assert source.read_bytes() == b"picture bytes"
    assert not destination.exists()


def test_a_folder_that_refuses_writing_is_reported_at_once(
    tmp_path: Path, monkeypatch
) -> None:
    source = _picture(tmp_path)
    destination = tmp_path / "locked" / "picture.png"
    attempts = []

    def denied(src, *_args, **_kwargs):
        attempts.append(src)
        raise PermissionError(errno.EACCES, "Access is denied")

    monkeypatch.setattr(image_manager.os, "replace", denied)

    with pytest.raises(PermissionError):
        image_manager._move_file_atomically(str(source), str(destination))

    assert len(attempts) == 1
