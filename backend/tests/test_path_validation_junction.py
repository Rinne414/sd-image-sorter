"""Scanning must work on the Python 3.11 runtime that older portable installs keep.

The in-app updater replaces app files but not the bundled interpreter, so an
install first unpacked with Python 3.11 still runs 3.11 today. os.path.isjunction
only exists from 3.12; calling it crashed every folder scan (drag-and-drop too).
"""

from __future__ import annotations

import os
import subprocess

import pytest

from utils.path_validation import is_directory_symlink_or_junction


def test_plain_folder_is_not_a_link_when_isjunction_is_missing(tmp_path, monkeypatch):
    monkeypatch.delattr(os.path, "isjunction", raising=False)
    folder = tmp_path / "plain"
    folder.mkdir()

    assert is_directory_symlink_or_junction(folder) is False


@pytest.mark.skipif(os.name != "nt", reason="junctions are a Windows feature")
def test_windows_junction_is_detected_when_isjunction_is_missing(tmp_path, monkeypatch):
    target = tmp_path / "target"
    target.mkdir()
    junction = tmp_path / "junction"
    subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(junction), str(target)],
        check=True,
        capture_output=True,
    )
    monkeypatch.delattr(os.path, "isjunction", raising=False)

    assert is_directory_symlink_or_junction(junction) is True
    assert is_directory_symlink_or_junction(target) is False
