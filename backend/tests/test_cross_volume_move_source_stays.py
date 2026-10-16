"""A cross-drive move whose source cannot be removed takes its copy back.

The fallback copies, then removes the source. When the removal failed
(another program holding the file), the move failed but the copy stayed in
the destination: a second file the next scan would index as a new image.
"""

from __future__ import annotations

import errno
import os
from pathlib import Path

import pytest

import image_manager


def _held_source(monkeypatch, source: Path) -> None:
    """Rename reports another drive; removing the source is refused."""
    real_replace = os.replace
    real_unlink = os.unlink

    def other_drive(src, dst, *args, **kwargs):
        if os.path.abspath(str(src)) == os.path.abspath(str(source)):
            raise OSError(errno.EXDEV, "Invalid cross-device link")
        return real_replace(src, dst, *args, **kwargs)

    def held(path, *args, **kwargs):
        if os.path.abspath(str(path)) == os.path.abspath(str(source)):
            raise PermissionError(errno.EACCES, "The file is in use by another program")
        return real_unlink(path, *args, **kwargs)

    monkeypatch.setattr(image_manager.os, "replace", other_drive)
    monkeypatch.setattr(image_manager.os, "unlink", held)


def test_the_copy_is_taken_back_when_the_source_stays(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "drive-a" / "picture.png"
    source.parent.mkdir()
    source.write_bytes(b"picture bytes")
    destination = tmp_path / "drive-b" / "picture.png"
    destination.parent.mkdir()
    _held_source(monkeypatch, source)

    with pytest.raises(PermissionError):
        image_manager._move_file_atomically(str(source), str(destination))

    assert source.read_bytes() == b"picture bytes"
    assert list(destination.parent.iterdir()) == []


def test_a_destination_that_existed_is_left_as_it_is(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "drive-a" / "picture.png"
    source.parent.mkdir()
    source.write_bytes(b"new bytes")
    destination = tmp_path / "drive-b" / "picture.png"
    destination.parent.mkdir()
    destination.write_bytes(b"old bytes")
    _held_source(monkeypatch, source)

    with pytest.raises(PermissionError):
        image_manager._move_file_atomically(str(source), str(destination))

    # Already replaced by the copy: removing it would lose the file outright.
    assert destination.exists()
    assert source.read_bytes() == b"new bytes"
