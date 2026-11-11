"""Rename a folder of the library on disk and keep every picture in it.

The sidebar's folder tree could show folders and take dropped pictures, but a
folder's name could only be changed outside the program, after which every
picture in it counted as missing. This renames the folder itself (one rename
on disk, so captions and anything else in it travel along), then points the
library's records at the new place: each picture's path, the path identity
favourites use, and any library root at or under the folder.

The picture rows get the same statement a move gives them
(``db_images_write_lifecycle.update_image_path``), in one transaction. When
the records cannot be written, the folder is renamed back.
"""

from __future__ import annotations

import os
import sqlite3
from typing import Any, Dict, List, Tuple

from db_core import get_db
from db_helpers import _normalize_indexed_image_path
from db_images_write import _sync_image_path_identity
from db_images_write_lifecycle import _invalidate_facet_caches, delete_images_by_ids
from db_library_roots import _normalize_root_path, _root_path_key
from image_manager import _once_the_file_is_free
from utils.source_paths import is_indexed_image_path_in_folder_scope

# Characters no folder name may hold on Windows; refused everywhere so a
# library keeps working when it is carried to another computer.
_FORBIDDEN_IN_NAME = set('<>:"/\\|?*')
_RESERVED_NAMES = {
    "con", "prn", "aux", "nul",
    *(f"com{n}" for n in range(1, 10)),
    *(f"lpt{n}" for n in range(1, 10)),
}  # fmt: skip


class FolderRenameError(Exception):
    """Why the folder was not renamed; ``code`` names the reason for the page."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def checked_name(raw: str) -> str:
    """The new name, or the reason it cannot be a folder's name."""
    name = str(raw or "").strip()
    if not name or name in {".", ".."}:
        raise FolderRenameError("name_empty", "Type a name for the folder.")
    if any(ch in _FORBIDDEN_IN_NAME or ord(ch) < 32 for ch in name):
        raise FolderRenameError(
            "name_invalid",
            'A folder name cannot contain any of these: < > : " / \\ | ? *',
        )
    if name.endswith((" ", ".")):
        raise FolderRenameError(
            "name_invalid", "A folder name cannot end with a dot or a space."
        )
    if name.split(".")[0].lower() in _RESERVED_NAMES:
        raise FolderRenameError(
            "name_invalid", f"Windows keeps the name {name} for itself."
        )
    return name


def _new_path(old_path: str, old_folder: str, new_folder: str) -> str:
    """The picture's path after the rename, in the separators it already uses."""
    normalized = _normalize_indexed_image_path(old_path)
    tail = normalized[len(old_folder) :]
    separator = "\\" if "\\" in normalized and "/" not in normalized else "/"
    return new_folder.replace("/", separator).replace("\\", separator) + tail


def _pictures_in(
    cursor: sqlite3.Cursor, folder: str
) -> Tuple[List[Tuple[int, str]], int]:
    """Every indexed picture at any depth under ``folder``, in every library.

    Also how many of them have a file the program could read: a record of a
    file that was already missing follows the folder but is not a picture the
    user sees.
    """
    cursor.execute("SELECT id, path, is_readable FROM images")
    found: List[Tuple[int, str]] = []
    readable = 0
    while True:
        rows = cursor.fetchmany(5000)
        if not rows:
            return found, readable
        for row in rows:
            if is_indexed_image_path_in_folder_scope(row["path"], folder):
                found.append((int(row["id"]), str(row["path"])))
                readable += 0 if row["is_readable"] == 0 else 1


def _forget_records_in_the_way(
    pictures: List[Tuple[int, str]], old: str, new: str
) -> int:
    """Drop records that already claim a path a renamed picture is about to take.

    The new folder did not exist a moment ago, so such a record is of a file
    that is gone (the folder had this name once and was renamed outside the
    program). The picture now at that path is the one being renamed.
    """
    moving = {image_id for image_id, _path in pictures}
    targets = [
        _normalize_indexed_image_path(_new_path(path, old, new))
        for _id, path in pictures
    ]
    in_the_way: List[int] = []
    with get_db() as conn:
        cursor = conn.cursor()
        for start in range(0, len(targets), 500):
            chunk = targets[start : start + 500]
            cursor.execute(
                f"SELECT id FROM images WHERE path IN ({','.join('?' * len(chunk))})",
                chunk,
            )
            in_the_way.extend(
                int(row["id"])
                for row in cursor.fetchall()
                if int(row["id"]) not in moving
            )
    if in_the_way:
        delete_images_by_ids(in_the_way)
    return len(in_the_way)


def _repoint_pictures(
    cursor: sqlite3.Cursor, pictures: List[Tuple[int, str]], old: str, new: str
) -> None:
    for image_id, old_path in pictures:
        new_path = _normalize_indexed_image_path(_new_path(old_path, old, new))
        cursor.execute(
            "UPDATE images SET path = ?, indexed_at = CURRENT_TIMESTAMP WHERE id = ?",
            (new_path, image_id),
        )
        _sync_image_path_identity(cursor, image_id, new_path)


def _repoint_roots(cursor: sqlite3.Cursor, old: str, new: str) -> int:
    """Library roots at or under the folder follow it."""
    cursor.execute("SELECT id, path FROM library_roots")
    moved = 0
    for row in cursor.fetchall():
        root = _normalize_root_path(row["path"])
        if not is_indexed_image_path_in_folder_scope(root, old):
            continue
        new_root = _normalize_root_path(new + root[len(_normalize_root_path(old)) :])
        cursor.execute(
            "UPDATE OR REPLACE library_roots SET path = ?, path_key = ? WHERE id = ?",
            (new_root, _root_path_key(new_root), row["id"]),
        )
        moved += 1
    return moved


def rename_folder(folder: str, new_name: str) -> Dict[str, Any]:
    """Rename ``folder`` to ``new_name`` beside it and repoint the library.

    Returns ``{"old_path", "new_path", "pictures", "records", "roots", "replaced"}``. Raises
    :class:`FolderRenameError` and changes nothing when it cannot be done.
    """
    name = checked_name(new_name)
    old = os.path.normpath(folder)
    if not os.path.isdir(old):
        raise FolderRenameError("folder_missing", "That folder is no longer there.")
    parent = os.path.dirname(old)
    if not parent or parent == old:
        raise FolderRenameError("is_drive", "A drive cannot be renamed here.")
    if any(
        part.lower().endswith(".library") for part in old.replace("\\", "/").split("/")
    ):
        raise FolderRenameError(
            "eagle_library",
            "This folder belongs to an Eagle library; rename it in Eagle.",
        )
    new = os.path.join(parent, name)
    same_folder = os.path.exists(new) and os.path.samefile(old, new)
    if os.path.basename(old) == name:
        raise FolderRenameError("name_same", "The folder already has that name.")
    if os.path.exists(new) and not same_folder:
        raise FolderRenameError(
            "name_taken", f"A folder or file named {name} is already there."
        )

    old_indexed = _normalize_root_path(_normalize_indexed_image_path(old))
    new_indexed = _normalize_root_path(_normalize_indexed_image_path(new))
    with get_db() as conn:
        pictures, readable = _pictures_in(conn.cursor(), old_indexed)

    try:
        _once_the_file_is_free(os.rename, old, new)
    except PermissionError as exc:
        raise FolderRenameError(
            "in_use",
            "Windows would not rename the folder: a file in it is open in "
            "another program, or the folder is open elsewhere. Close it and try again.",
        ) from exc
    except OSError as exc:
        raise FolderRenameError("os_error", str(exc)) from exc

    try:
        replaced = _forget_records_in_the_way(pictures, old_indexed, new_indexed)
        with get_db() as conn:
            cursor = conn.cursor()
            _repoint_pictures(cursor, pictures, old_indexed, new_indexed)
            roots = _repoint_roots(cursor, old_indexed, new_indexed)
    except Exception:
        # The records still name the old folder: put the folder back under it.
        os.rename(new, old)
        raise

    _invalidate_facet_caches()
    return {
        "old_path": old_indexed,
        "new_path": new_indexed,
        "pictures": readable,
        "records": len(pictures),
        "roots": roots,
        "replaced": replaced,
    }
