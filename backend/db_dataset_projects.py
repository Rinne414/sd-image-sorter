"""Transactional persistence for named Dataset Maker projects."""
from __future__ import annotations

import os
import sqlite3
import stat
from typing import Literal, NoReturn, TypedDict

from db_core import get_db
from utils.dataset_ids import dataset_source_id


class DatasetProjectLibraryItemInput(TypedDict):
    item_type: Literal["library"]
    image_id: int


class DatasetProjectLocalItemInput(TypedDict):
    item_type: Literal["local"]
    path: str
    path_key: str
    size: int
    mtime_ns: str
    device: str
    inode: str


DatasetProjectItemInput = DatasetProjectLibraryItemInput | DatasetProjectLocalItemInput


class DatasetProjectLibraryItemRecord(TypedDict):
    position: int
    item_type: Literal["library"]
    source_image_id: int
    image_id: int | None
    missing: bool


class DatasetProjectLocalItemRecord(TypedDict):
    position: int
    item_type: Literal["local"]
    ds_id: str
    path: str
    size: int
    mtime_ns: str
    device: str
    inode: str
    source_status: Literal["available", "missing", "changed"]


DatasetProjectItemRecord = (
    DatasetProjectLibraryItemRecord | DatasetProjectLocalItemRecord
)


class DatasetProjectRecord(TypedDict):
    id: int
    name: str
    revision: int
    archived_at: str | None
    created_at: str
    updated_at: str
    settings_json: str
    missing_image_ids: list[int]
    items: list[DatasetProjectItemRecord]


class DatasetProjectSummaryRecord(TypedDict):
    id: int
    name: str
    revision: int
    archived_at: str | None
    created_at: str
    updated_at: str
    item_count: int
    missing_image_count: int


class DatasetProjectError(RuntimeError):
    """Base class for expected Dataset project persistence conflicts."""


class DatasetProjectNotFoundError(DatasetProjectError):
    def __init__(self, project_id: int):
        self.project_id = project_id
        super().__init__(f"Dataset project {project_id} was not found")


class DatasetProjectRevisionConflictError(DatasetProjectError):
    def __init__(self, project_id: int, expected_revision: int, current_revision: int):
        self.project_id = project_id
        self.expected_revision = expected_revision
        self.current_revision = current_revision
        super().__init__(
            f"Dataset project {project_id} revision conflict: expected "
            f"{expected_revision}, current {current_revision}"
        )


class DatasetProjectNameConflictError(DatasetProjectError):
    def __init__(self, name: str):
        self.name = name
        super().__init__(f"An active Dataset project already uses the name {name!r}")


class DatasetProjectImageNotFoundError(DatasetProjectError):
    def __init__(self, image_ids: list[int]):
        self.image_ids = image_ids
        super().__init__(f"Dataset project images were not found: {image_ids}")


class DatasetProjectSourceValidationError(DatasetProjectError):
    def __init__(self, path: str, reason: str):
        self.path = path
        self.reason = reason
        super().__init__(f"Dataset project local source {path!r} is invalid: {reason}")


class DatasetProjectStateConflictError(DatasetProjectError):
    def __init__(self, project_id: int, state: str, action: str):
        self.project_id = project_id
        self.state = state
        self.action = action
        super().__init__(
            f"Dataset project {project_id} is {state} and cannot be {action}"
        )


def _begin_write(conn: sqlite3.Connection) -> None:
    conn.execute("BEGIN IMMEDIATE")


def _read_project_row(
    conn: sqlite3.Connection,
    project_id: int,
) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT id, name, revision, archived_at, created_at, updated_at,
               settings_json
        FROM dataset_projects
        WHERE id = ?
        """,
        (project_id,),
    ).fetchone()


def _require_project_row(
    conn: sqlite3.Connection,
    project_id: int,
) -> sqlite3.Row:
    row = _read_project_row(conn, project_id)
    if row is None:
        raise DatasetProjectNotFoundError(project_id)
    return row


def _require_revision(
    row: sqlite3.Row,
    project_id: int,
    expected_revision: int,
) -> None:
    current_revision = int(row["revision"])
    if current_revision != expected_revision:
        raise DatasetProjectRevisionConflictError(
            project_id,
            expected_revision,
            current_revision,
        )


def _require_active_name_available(
    conn: sqlite3.Connection,
    name: str,
    name_key: str,
    excluded_project_id: int | None,
) -> None:
    if excluded_project_id is None:
        row = conn.execute(
            """
            SELECT id FROM dataset_projects
            WHERE name_key = ? AND archived_at IS NULL
            LIMIT 1
            """,
            (name_key,),
        ).fetchone()
    else:
        row = conn.execute(
            """
            SELECT id FROM dataset_projects
            WHERE name_key = ? AND archived_at IS NULL AND id != ?
            LIMIT 1
            """,
            (name_key, excluded_project_id),
        ).fetchone()
    if row is not None:
        raise DatasetProjectNameConflictError(name)


def _require_images_exist(
    conn: sqlite3.Connection,
    image_ids: list[int],
) -> None:
    if not image_ids:
        return
    found_ids: set[int] = set()
    for start in range(0, len(image_ids), 500):
        chunk = image_ids[start:start + 500]
        placeholders = ",".join("?" for _image_id in chunk)
        rows = conn.execute(
            f"SELECT id FROM images WHERE id IN ({placeholders})",
            chunk,
        ).fetchall()
        found_ids.update(int(row[0]) for row in rows)
    missing_ids = [image_id for image_id in image_ids if image_id not in found_ids]
    if missing_ids:
        raise DatasetProjectImageNotFoundError(missing_ids)


def _replace_project_items(
    conn: sqlite3.Connection,
    project_id: int,
    items: list[DatasetProjectItemInput],
) -> None:
    conn.execute(
        "DELETE FROM dataset_project_items WHERE project_id = ?",
        (project_id,),
    )
    conn.execute(
        "DELETE FROM dataset_project_local_sources WHERE project_id = ?",
        (project_id,),
    )
    for position, item in enumerate(items):
        if item["item_type"] == "library":
            image_id = item["image_id"]
            conn.execute(
                """
                INSERT INTO dataset_project_items (
                    project_id, position, item_type, source_image_id,
                    image_id, local_source_id
                ) VALUES (?, ?, 'library', ?, ?, NULL)
                """,
                (project_id, position, image_id, image_id),
            )
            continue

        cursor = conn.execute(
            """
            INSERT INTO dataset_project_local_sources (
                project_id, path, path_key, size, mtime_ns, device, inode
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project_id,
                item["path"],
                item["path_key"],
                item["size"],
                item["mtime_ns"],
                item["device"],
                item["inode"],
            ),
        )
        local_source_id = cursor.lastrowid
        if local_source_id is None:
            raise RuntimeError(
                "Dataset project local source insert did not return a row ID"
            )
        conn.execute(
            """
            INSERT INTO dataset_project_items (
                project_id, position, item_type, source_image_id,
                image_id, local_source_id
            ) VALUES (?, ?, 'local', NULL, NULL, ?)
            """,
            (project_id, position, int(local_source_id)),
        )


def _local_source_status(
    path: str,
    size: int,
    mtime_ns: str,
    device: str,
    inode: str,
) -> Literal["available", "missing", "changed"]:
    try:
        current = os.lstat(path)
    except (FileNotFoundError, NotADirectoryError):
        return "missing"
    except OSError:
        return "changed"
    if not stat.S_ISREG(current.st_mode):
        return "changed"
    if (
        current.st_size != size
        or current.st_mtime_ns != int(mtime_ns)
        or current.st_dev != int(device)
        or current.st_ino != int(inode)
    ):
        return "changed"
    return "available"


def _library_item_record(item_row: sqlite3.Row) -> DatasetProjectLibraryItemRecord:
    image_id = (
        int(item_row["image_id"])
        if item_row["image_id"] is not None
        else None
    )
    return {
        "position": int(item_row["position"]),
        "item_type": "library",
        "source_image_id": int(item_row["source_image_id"]),
        "image_id": image_id,
        "missing": image_id is None,
    }


def _local_item_record(item_row: sqlite3.Row) -> DatasetProjectLocalItemRecord:
    path = str(item_row["path"])
    size = int(item_row["size"])
    mtime_ns = str(item_row["mtime_ns"])
    device = str(item_row["device"])
    inode = str(item_row["inode"])
    return {
        "position": int(item_row["position"]),
        "item_type": "local",
        "ds_id": dataset_source_id(path),
        "path": path,
        "size": size,
        "mtime_ns": mtime_ns,
        "device": device,
        "inode": inode,
        "source_status": _local_source_status(
            path,
            size,
            mtime_ns,
            device,
            inode,
        ),
    }


def _read_project_record(
    conn: sqlite3.Connection,
    project_id: int,
) -> DatasetProjectRecord:
    row = _require_project_row(conn, project_id)
    item_rows = conn.execute(
        """
        SELECT i.position, i.item_type, i.source_image_id, i.image_id,
               s.path, s.size, s.mtime_ns, s.device, s.inode
        FROM dataset_project_items i
        LEFT JOIN dataset_project_local_sources s
            ON s.id = i.local_source_id AND s.project_id = i.project_id
        WHERE i.project_id = ?
        ORDER BY i.position
        """,
        (project_id,),
    ).fetchall()
    items: list[DatasetProjectItemRecord] = [
        _library_item_record(item_row)
        if item_row["item_type"] == "library"
        else _local_item_record(item_row)
        for item_row in item_rows
    ]
    return {
        "id": int(row["id"]),
        "name": str(row["name"]),
        "revision": int(row["revision"]),
        "archived_at": (
            str(row["archived_at"]) if row["archived_at"] is not None else None
        ),
        "created_at": str(row["created_at"]),
        "updated_at": str(row["updated_at"]),
        "settings_json": str(row["settings_json"]),
        "missing_image_ids": [
            item["source_image_id"]
            for item in items
            if item["item_type"] == "library" and item["missing"]
        ],
        "items": items,
    }


def _raise_cas_failure(
    conn: sqlite3.Connection,
    project_id: int,
    expected_revision: int,
) -> NoReturn:
    row = _read_project_row(conn, project_id)
    if row is None:
        raise DatasetProjectNotFoundError(project_id)
    raise DatasetProjectRevisionConflictError(
        project_id,
        expected_revision,
        int(row["revision"]),
    )


def list_dataset_project_records(
    archived: bool,
) -> list[DatasetProjectSummaryRecord]:
    archived_clause = "IS NOT NULL" if archived else "IS NULL"
    with get_db() as conn:
        rows = conn.execute(
            f"""
            SELECT p.id, p.name, p.revision, p.archived_at,
                   p.created_at, p.updated_at,
                   COUNT(i.position) AS item_count,
                   COALESCE(SUM(
                       CASE
                           WHEN i.item_type = 'library' AND i.image_id IS NULL THEN 1
                           ELSE 0
                       END
                   ), 0)
                       AS missing_image_count
            FROM dataset_projects p
            LEFT JOIN dataset_project_items i ON i.project_id = p.id
            WHERE p.archived_at {archived_clause}
            GROUP BY p.id
            ORDER BY p.updated_at DESC, p.id DESC
            """
        ).fetchall()
        return [
            {
                "id": int(row["id"]),
                "name": str(row["name"]),
                "revision": int(row["revision"]),
                "archived_at": (
                    str(row["archived_at"])
                    if row["archived_at"] is not None
                    else None
                ),
                "created_at": str(row["created_at"]),
                "updated_at": str(row["updated_at"]),
                "item_count": int(row["item_count"]),
                "missing_image_count": int(row["missing_image_count"]),
            }
            for row in rows
        ]


def get_dataset_project_record(project_id: int) -> DatasetProjectRecord:
    with get_db() as conn:
        return _read_project_record(conn, project_id)


def require_dataset_project_revision(
    project_id: int,
    expected_revision: int,
) -> DatasetProjectRecord:
    with get_db() as conn:
        row = _require_project_row(conn, project_id)
        _require_revision(row, project_id, expected_revision)
        return _read_project_record(conn, project_id)


def create_dataset_project_record(
    name: str,
    name_key: str,
    items: list[DatasetProjectItemInput],
    settings_json: str,
) -> DatasetProjectRecord:
    with get_db() as conn:
        _begin_write(conn)
        _require_active_name_available(conn, name, name_key, None)
        _require_images_exist(
            conn,
            [item["image_id"] for item in items if item["item_type"] == "library"],
        )
        cursor = conn.execute(
            """
            INSERT INTO dataset_projects (name, name_key, settings_json)
            VALUES (?, ?, ?)
            """,
            (name, name_key, settings_json),
        )
        project_id = int(cursor.lastrowid)
        _replace_project_items(conn, project_id, items)
        return _read_project_record(conn, project_id)


def update_dataset_project_record(
    project_id: int,
    expected_revision: int,
    name: str,
    name_key: str,
    items: list[DatasetProjectItemInput],
    settings_json: str,
) -> DatasetProjectRecord:
    with get_db() as conn:
        _begin_write(conn)
        row = _require_project_row(conn, project_id)
        _require_revision(row, project_id, expected_revision)
        if row["archived_at"] is not None:
            raise DatasetProjectStateConflictError(project_id, "archived", "updated")
        _require_active_name_available(conn, name, name_key, project_id)
        _require_images_exist(
            conn,
            [item["image_id"] for item in items if item["item_type"] == "library"],
        )
        cursor = conn.execute(
            """
            UPDATE dataset_projects
            SET name = ?, name_key = ?, settings_json = ?,
                revision = revision + 1,
                updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ? AND revision = ? AND archived_at IS NULL
            """,
            (name, name_key, settings_json, project_id, expected_revision),
        )
        if cursor.rowcount != 1:
            _raise_cas_failure(conn, project_id, expected_revision)
        _replace_project_items(conn, project_id, items)
        return _read_project_record(conn, project_id)


def archive_dataset_project_record(
    project_id: int,
    expected_revision: int,
) -> DatasetProjectRecord:
    with get_db() as conn:
        _begin_write(conn)
        row = _require_project_row(conn, project_id)
        _require_revision(row, project_id, expected_revision)
        if row["archived_at"] is not None:
            raise DatasetProjectStateConflictError(project_id, "archived", "archived")
        cursor = conn.execute(
            """
            UPDATE dataset_projects
            SET archived_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'),
                revision = revision + 1,
                updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ? AND revision = ? AND archived_at IS NULL
            """,
            (project_id, expected_revision),
        )
        if cursor.rowcount != 1:
            _raise_cas_failure(conn, project_id, expected_revision)
        return _read_project_record(conn, project_id)


def restore_dataset_project_record(
    project_id: int,
    expected_revision: int,
) -> DatasetProjectRecord:
    with get_db() as conn:
        _begin_write(conn)
        row = _require_project_row(conn, project_id)
        _require_revision(row, project_id, expected_revision)
        if row["archived_at"] is None:
            raise DatasetProjectStateConflictError(project_id, "active", "restored")
        name = str(row["name"])
        name_key = name.casefold()
        _require_active_name_available(conn, name, name_key, project_id)
        cursor = conn.execute(
            """
            UPDATE dataset_projects
            SET archived_at = NULL, name_key = ?, revision = revision + 1,
                updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ? AND revision = ? AND archived_at IS NOT NULL
            """,
            (name_key, project_id, expected_revision),
        )
        if cursor.rowcount != 1:
            _raise_cas_failure(conn, project_id, expected_revision)
        return _read_project_record(conn, project_id)


def delete_dataset_project_record(
    project_id: int,
    expected_revision: int,
) -> None:
    with get_db() as conn:
        _begin_write(conn)
        row = _require_project_row(conn, project_id)
        _require_revision(row, project_id, expected_revision)
        cursor = conn.execute(
            "DELETE FROM dataset_projects WHERE id = ? AND revision = ?",
            (project_id, expected_revision),
        )
        if cursor.rowcount != 1:
            _raise_cas_failure(conn, project_id, expected_revision)
