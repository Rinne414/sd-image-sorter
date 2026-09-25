"""Transactional writes that link V4 dataset batches to Dataset Maker projects.

The project (``dataset_projects``) is the single source of truth for a dataset
batch's name, items, order and V1 settings (D26); the batch row keeps only V4
shell state. Every function here changes a batch and its project in ONE
transaction. It reuses the in-transaction helpers of ``db_batches`` (its
sibling) and of the V3.5 project module, so the V3.5 module stays unchanged
and both sides keep enforcing the same rules (library scope, active-name
uniqueness, item layout).
"""

from __future__ import annotations

import sqlite3
from typing import Any

import db_dataset_projects as project_db
from db_batches import (
    _NOW,
    BatchError,
    _batch_row,
    _begin_write,
    _chunks,
    _require_library_images,
    _update_batch_row,
    project_summaries,
)
from db_core import get_db
from library_context import current_library_sql, get_current_library_id


class BatchDatasetProjectNotFoundError(BatchError):
    def __init__(self, project_id: int):
        self.project_id = project_id
        super().__init__(f"Dataset project {project_id} was not found")


class BatchDatasetNameConflictError(BatchError):
    def __init__(self, name: str):
        self.name = name
        super().__init__(f"An active dataset project already uses the name {name!r}")


class BatchNotDatasetError(BatchError):
    def __init__(self, batch_id: int):
        self.batch_id = batch_id
        super().__init__(f"Batch {batch_id} is not a dataset batch")


class BatchDatasetOrphanedError(BatchError):
    def __init__(self, batch_id: int):
        self.batch_id = batch_id
        super().__init__(
            f"The dataset project of batch {batch_id} was deleted; "
            "the batch can only be deleted"
        )


def _require_name_free(
    conn: sqlite3.Connection, name: str, project_id: int | None
) -> None:
    try:
        project_db._require_active_name_available(
            conn, name, name.casefold(), project_id
        )
    except project_db.DatasetProjectNameConflictError as error:
        raise BatchDatasetNameConflictError(name) from error


def _project_row(conn: sqlite3.Connection, project_id: int) -> sqlite3.Row:
    lib_sql, lib_params = current_library_sql()
    row = conn.execute(
        f"SELECT id, name, archived_at FROM dataset_projects WHERE id = ? AND {lib_sql}",
        (project_id, *lib_params),
    ).fetchone()
    if row is None:
        raise BatchDatasetProjectNotFoundError(project_id)
    return row


def _insert_batch(
    conn: sqlite3.Connection,
    shell: dict[str, Any],
    name: str,
    project_id: int,
    archived_at: str | None,
) -> int:
    return int(
        conn.execute(
            """
            INSERT INTO batches (
                library_id, kind, name, steps_json, settings_json, current_step,
                dataset_project_id, archived_at
            ) VALUES (?, 'dataset', ?, ?, ?, ?, ?, ?)
            """,
            (
                get_current_library_id(),
                name,
                shell["steps_json"],
                shell["settings_json"],
                shell["current_step"],
                project_id,
                archived_at,
            ),
        ).lastrowid
    )


def create_dataset_batch(
    name: str,
    shell: dict[str, Any],
    image_ids: list[int],
    project_settings_json: str,
) -> tuple[int, list[int]]:
    """Create a project (Library images in order) and its batch together.

    ``shell`` carries the batch row's ``steps_json``, ``settings_json`` and
    ``current_step``. Repeated ids are skipped and reported, like the batch API.
    """
    unique_ids = list(dict.fromkeys(image_ids))
    skipped: list[int] = []
    seen: set[int] = set()
    for image_id in image_ids:
        if image_id in seen:
            skipped.append(image_id)
        seen.add(image_id)
    with get_db() as conn:
        _begin_write(conn)
        _require_library_images(conn, unique_ids)
        _require_name_free(conn, name, None)
        project_id = int(
            conn.execute(
                """
                INSERT INTO dataset_projects (name, name_key, settings_json, library_id)
                VALUES (?, ?, ?, ?)
                """,
                (
                    name,
                    name.casefold(),
                    project_settings_json,
                    get_current_library_id(),
                ),
            ).lastrowid
        )
        project_db._replace_project_items(
            conn,
            project_id,
            [
                {"item_type": "library", "image_id": image_id, "missing": False}
                for image_id in unique_ids
            ],
        )
        return _insert_batch(conn, shell, name, project_id, None), skipped


def link_dataset_project(project_id: int, shell: dict[str, Any]) -> tuple[int, bool]:
    """Return the project's batch, creating it on first use (``True`` = created)."""
    lib_sql, lib_params = current_library_sql()
    with get_db() as conn:
        _begin_write(conn)
        project = _project_row(conn, project_id)
        existing = conn.execute(
            f"SELECT id FROM batches WHERE dataset_project_id = ? AND {lib_sql}",
            (project_id, *lib_params),
        ).fetchone()
        if existing is not None:
            return int(existing[0]), False
        batch_id = _insert_batch(
            conn, shell, str(project["name"]), project_id, project["archived_at"]
        )
        return batch_id, True


def _forward_to_project(
    conn: sqlite3.Connection,
    project_id: int,
    name: str | None,
    archived: bool | None,
) -> None:
    """Rename, archive or restore the project; bump its revision so an open
    V3.5 editor reloads instead of saving its old name back."""
    project = _project_row(conn, project_id)
    was_archived = project["archived_at"] is not None
    new_name = str(project["name"]) if name is None else name
    will_archive = was_archived if archived is None else archived
    if new_name == project["name"] and will_archive == was_archived:
        return
    if not will_archive:
        _require_name_free(conn, new_name, project_id)
    archived_sql = "archived_at"
    if will_archive != was_archived:
        archived_sql = _NOW if will_archive else "NULL"
    conn.execute(
        f"""
        UPDATE dataset_projects
        SET name = ?, name_key = ?, archived_at = {archived_sql},
            revision = revision + 1, updated_at = {_NOW}
        WHERE id = ?
        """,
        (new_name, new_name.casefold(), project_id),
    )


def update_dataset_batch(
    batch_id: int, expected_revision: int, fields: dict[str, Any]
) -> None:
    """Compare-and-set the batch row; ``name`` and ``archived`` also go to the project.

    The batch row keeps a copy of both, so an orphaned batch still shows the
    last name it had.
    """
    forwarded = "name" in fields or "archived" in fields
    with get_db() as conn:
        _begin_write(conn)
        row = _batch_row(conn, batch_id)
        project_id = row["dataset_project_id"]
        if forwarded and project_id is None:
            raise BatchDatasetOrphanedError(batch_id)
        _update_batch_row(conn, batch_id, expected_revision, fields)
        if forwarded:
            _forward_to_project(
                conn, int(project_id), fields.get("name"), fields.get("archived")
            )


def list_unlinked_projects(include_archived: bool) -> list[dict[str, Any]]:
    """This library's projects that no batch shows yet (made in V3.5)."""
    lib_sql, lib_params = current_library_sql("p.library_id")
    archived_sql = "" if include_archived else " AND p.archived_at IS NULL"
    with get_db() as conn:
        ids = [
            int(row[0])
            for row in conn.execute(
                f"""
                SELECT p.id FROM dataset_projects p
                WHERE {lib_sql}{archived_sql}
                  AND NOT EXISTS (
                      SELECT 1 FROM batches b WHERE b.dataset_project_id = p.id
                  )
                """,
                lib_params,
            ).fetchall()
        ]
        summaries = project_summaries(conn, ids)
    return sorted(
        summaries.values(),
        key=lambda project: (project["updated_at"], project["id"]),
        reverse=True,
    )


def library_image_info(image_ids: list[int]) -> list[dict[str, Any]]:
    """File name and size of this library's images, for a dataset batch's tiles."""
    lib_sql, lib_params = current_library_sql()
    found: list[dict[str, Any]] = []
    with get_db() as conn:
        for chunk in _chunks(image_ids):
            placeholders = ",".join("?" for _ in chunk)
            rows = conn.execute(
                f"""
                SELECT id, filename, width, height FROM images
                WHERE id IN ({placeholders}) AND {lib_sql}
                """,
                (*chunk, *lib_params),
            ).fetchall()
            found.extend(dict(row) for row in rows)
    return found
