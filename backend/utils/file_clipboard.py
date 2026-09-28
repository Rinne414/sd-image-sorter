"""Put files (not pixels) on the Windows clipboard, as Explorer's Ctrl+C does.

A browser can only copy an image as a bitmap, which drops everything but the
first frame of an APNG. Chat programs accept a pasted *file* and send it byte
for byte, so a disguise keeps both its cover and its hidden animation.

The clipboard is claimed through a hidden window: with no owner window,
EmptyClipboard leaves the clipboard ownerless and SetClipboardData fails.
Calls go through ctypes; no helper process (PowerShell etc.) is started.
"""

from __future__ import annotations

import ctypes
import os
import struct
import sys
import time
from typing import Sequence

CF_HDROP = 15
GMEM_MOVEABLE = 0x0002
GMEM_ZEROINIT = 0x0040
DROPEFFECT_COPY = 1
_OPEN_ATTEMPTS = 10
_OPEN_RETRY_SECONDS = 0.05
# DROPFILES header: pFiles offset, pt.x, pt.y, fNC, fWide.
_DROPFILES_HEADER = struct.Struct("<IiiII")


class ClipboardUnsupported(RuntimeError):
    """Copying files to the clipboard is only implemented for Windows."""


class ClipboardBusy(RuntimeError):
    """Another program kept the clipboard open."""


def build_file_drop(paths: Sequence[str]) -> bytes:
    """CF_HDROP payload: a DROPFILES header, then NUL-separated wide paths."""
    names = "".join(f"{os.path.abspath(path)}\0" for path in paths) + "\0"
    header = _DROPFILES_HEADER.pack(_DROPFILES_HEADER.size, 0, 0, 0, 1)
    return header + names.encode("utf-16-le")


def copy_files(paths: Sequence[str]) -> None:
    """Replace the clipboard contents with the given files."""
    if not paths:
        raise ValueError("Nothing to copy")
    missing = [path for path in paths if not os.path.isfile(path)]
    if missing:
        raise FileNotFoundError(missing[0])
    if sys.platform != "win32":
        raise ClipboardUnsupported("Copying files to the clipboard needs Windows")
    _copy_files_windows(build_file_drop(paths))


def _copy_files_windows(drop: bytes) -> None:
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32.CreateWindowExW.restype = wintypes.HWND
    user32.CreateWindowExW.argtypes = [
        wintypes.DWORD,
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        wintypes.DWORD,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        wintypes.HWND,
        wintypes.HMENU,
        wintypes.HINSTANCE,
        wintypes.LPVOID,
    ]
    user32.DestroyWindow.argtypes = [wintypes.HWND]
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.OpenClipboard.restype = wintypes.BOOL
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    user32.SetClipboardData.restype = wintypes.HANDLE
    user32.RegisterClipboardFormatW.argtypes = [wintypes.LPCWSTR]
    user32.RegisterClipboardFormatW.restype = wintypes.UINT
    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalLock.restype = wintypes.LPVOID
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalFree.argtypes = [wintypes.HGLOBAL]

    def global_copy(data: bytes) -> int:
        handle = kernel32.GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, len(data))
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        pointer = kernel32.GlobalLock(handle)
        ctypes.memmove(pointer, data, len(data))
        kernel32.GlobalUnlock(handle)
        return handle

    window = user32.CreateWindowExW(
        0, "STATIC", None, 0, 0, 0, 0, 0, None, None, None, None
    )
    if not window:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        for _attempt in range(_OPEN_ATTEMPTS):
            if user32.OpenClipboard(window):
                break
            time.sleep(_OPEN_RETRY_SECONDS)
        else:
            raise ClipboardBusy("The clipboard is in use by another program")
        try:
            user32.EmptyClipboard()
            drop_handle = global_copy(drop)
            if not user32.SetClipboardData(CF_HDROP, drop_handle):
                kernel32.GlobalFree(drop_handle)
                raise ctypes.WinError(ctypes.get_last_error())
            # Tell paste targets this is a copy, not a cut-and-move.
            effect_format = user32.RegisterClipboardFormatW("Preferred DropEffect")
            effect_handle = global_copy(struct.pack("<I", DROPEFFECT_COPY))
            if not user32.SetClipboardData(effect_format, effect_handle):
                kernel32.GlobalFree(effect_handle)
        finally:
            user32.CloseClipboard()
    finally:
        user32.DestroyWindow(window)


def read_copied_files() -> list[str]:
    """The file paths currently on the clipboard (Windows); used by tests."""
    if sys.platform != "win32":
        raise ClipboardUnsupported("Reading files from the clipboard needs Windows")
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    shell32 = ctypes.WinDLL("shell32", use_last_error=True)
    user32.GetClipboardData.argtypes = [wintypes.UINT]
    user32.GetClipboardData.restype = wintypes.HANDLE
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    shell32.DragQueryFileW.argtypes = [
        wintypes.HANDLE,
        wintypes.UINT,
        wintypes.LPWSTR,
        wintypes.UINT,
    ]
    shell32.DragQueryFileW.restype = wintypes.UINT
    if not user32.OpenClipboard(None):
        raise ClipboardBusy("The clipboard is in use by another program")
    try:
        handle = user32.GetClipboardData(CF_HDROP)
        if not handle:
            return []
        count = shell32.DragQueryFileW(handle, 0xFFFFFFFF, None, 0)
        paths = []
        for index in range(count):
            length = shell32.DragQueryFileW(handle, index, None, 0)
            buffer = ctypes.create_unicode_buffer(length + 1)
            shell32.DragQueryFileW(handle, index, buffer, length + 1)
            paths.append(buffer.value)
        return paths
    finally:
        user32.CloseClipboard()
