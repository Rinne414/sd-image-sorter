"""Copying files (not pixels) to the clipboard."""

from __future__ import annotations

import os
import struct
import sys
from pathlib import Path

import pytest

from utils import file_clipboard


def test_the_drop_payload_lists_every_path_as_wide_text(tmp_path: Path) -> None:
    first = tmp_path / "一.png"
    second = tmp_path / "b c.png"

    payload = file_clipboard.build_file_drop([str(first), str(second)])

    offset, _x, _y, non_client, wide = struct.unpack("<IiiII", payload[:20])
    assert (offset, non_client, wide) == (20, 0, 1)
    names = payload[20:].decode("utf-16-le")
    assert names == f"{first}\0{second}\0\0"


def test_copying_nothing_or_a_missing_file_is_refused(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        file_clipboard.copy_files([])
    with pytest.raises(FileNotFoundError):
        file_clipboard.copy_files([str(tmp_path / "gone.png")])


@pytest.mark.skipif(sys.platform == "win32", reason="non-Windows behaviour")
def test_other_platforms_say_file_copy_is_unsupported(tmp_path: Path) -> None:
    picture = tmp_path / "a.png"
    picture.write_bytes(b"x")

    with pytest.raises(file_clipboard.ClipboardUnsupported):
        file_clipboard.copy_files([str(picture)])


@pytest.mark.skipif(
    sys.platform != "win32" or os.environ.get("SD_SORTER_TEST_CLIPBOARD") != "1",
    reason="replaces the real clipboard; set SD_SORTER_TEST_CLIPBOARD=1 on Windows to run",
)
def test_windows_clipboard_holds_the_copied_files(tmp_path: Path) -> None:
    first = tmp_path / "第一张.png"
    second = tmp_path / "second.png"
    first.write_bytes(b"1")
    second.write_bytes(b"2")
    saved_text = _read_clipboard_text()
    try:
        file_clipboard.copy_files([str(first), str(second)])

        assert file_clipboard.read_copied_files() == [str(first), str(second)]
    finally:
        if saved_text is not None:
            _write_clipboard_text(saved_text)


def _read_clipboard_text():
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32")
    kernel32 = ctypes.WinDLL("kernel32")
    user32.GetClipboardData.restype = wintypes.HANDLE
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalLock.restype = ctypes.c_wchar_p
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    if not user32.OpenClipboard(None):
        return None
    try:
        handle = user32.GetClipboardData(13)  # CF_UNICODETEXT
        if not handle:
            return None
        text = kernel32.GlobalLock(handle)
        kernel32.GlobalUnlock(handle)
        return text
    finally:
        user32.CloseClipboard()


def _write_clipboard_text(text: str) -> None:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32")
    kernel32 = ctypes.WinDLL("kernel32")
    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalLock.restype = wintypes.LPVOID
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    data = (text + "\0").encode("utf-16-le")
    handle = kernel32.GlobalAlloc(0x0042, len(data))
    ctypes.memmove(kernel32.GlobalLock(handle), data, len(data))
    kernel32.GlobalUnlock(handle)
    window = user32.CreateWindowExW(
        0, "STATIC", None, 0, 0, 0, 0, 0, None, None, None, None
    )
    try:
        if user32.OpenClipboard(window):
            try:
                user32.EmptyClipboard()
                user32.SetClipboardData(13, handle)
            finally:
                user32.CloseClipboard()
    finally:
        user32.DestroyWindow(window)
