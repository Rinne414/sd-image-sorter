"""Transactional persistence for V4 batches (migration 060).

Every query is pinned to the request's library (``X-SD-Library-Id``): a batch
or template of another library behaves exactly like one that does not exist.
``revision`` guards the batch row's own fields (name, steps, settings, current
step, archive state); item operations validate themselves and only touch
``updated_at``. A dataset batch is a view of its ``dataset_projects`` row (D26):
reads show the project's name, archive state and items, and the dataset
writes live in ``db_batch_datasets``.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Callable

from db_core import get_db
from library_context import current_library_sql, get_current_library_id

_CHUNK = 500
COVER_IMAGE_COUNT = 4
_NOW = "STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')"
_ITEM_COLUMNS = """
    bi.image_id, bi.position, bi.output_name, bi.censored_path, bi.censored_at,
    bi.item_state_json, i.filename, i.path, i.width, i.height
"""


class BatchError(RuntimeError):
    """Base class for expected batch conflicts."""


class BatchNotFoundError(BatchError):
    def __init__(self, batch_id: int):
        self.batch_id = batch_id
        super().__init__(f"Batch {batch_id} was not found")


class BatchImagesNotFoundError(BatchError):
    def __init__(self, image_ids: list[int]):
        self.image_ids = image_ids
        super().__init__(f"Library images were not found: {image_ids}")


class BatchItemNotFoundError(BatchError):
    def __init__(self, batch_id: int, image_id: int):
        self.batch_id = batch_id
        self.image_id = image_id
        super().__init__(f"Image {image_id} is not in batch {batch_id}")


class BatchTemplateNotFoundError(BatchError):
    def __init__(self, template_id: int):
        self.template_id = template_id
        super().__init__(f"Batch template {template_id} was not found")


class BatchRevisionConflictError(BatchError):
    def __init__(self, batch_id: int, expected_revision: int, current_revision: int):
        self.batch_id = batch_id
        self.expected_revision = expected_revision
        self.current_revision = current_revision
        super().__init__(
            f"Batch {batch_id} revision conflict: expected {expected_revision}, "
            f"current {current_revision}"
        )


class BatchItemsMismatchError(BatchError):
    def __init__(self, missing: list[int], unexpected: list[int]):
        self.missing_image_ids = missing
        self.unexpected_image_ids = unexpected
        super().__init__("The ordered ids do not match the batch's current items")


class BatchDatasetItemsInProjectError(BatchError):
    def __init__(self, batch_id: int):
        self.batch_id = batch_id
        super().__init__(
            f"Batch {batch_id} is a dataset batch: its images, folder images and "
            "order live in its dataset project"
        )


class BatchProjectRevisionConflictError(BatchError):
    def __init__(self, project_id: int, expected_revision: int, current_revision: int):
        self.project_id = project_id
        self.expected_revision = expected_revision
        self.current_revision = current_revision
        super().__init__(
            f"Dataset project {project_id} revision conflict: expected "
            f"{expected_revision}, current {current_revision}"
        )


def _begin_write(conn: sqlite3.Connection) -> None:
    conn.execute("BEGIN IMMEDIATE")


def _chunks(values: list[int]):
    for start in range(0, len(values), _CHUNK):
        yield values[start : start + _CHUNK]


def _batch_row(conn: sqlite3.Connection, batch_id: int) -> sqlite3.Row:
    lib_sql, lib_params = current_library_sql()
    row = conn.execute(
        f"SELECT * FROM batches WHERE id = ? AND {lib_sql}",
        (batch_id, *lib_params),
    ).fetchone()
    if row is None:
        raise BatchNotFoundError(batch_id)
    return row


def _require_own_items(row: sqlite3.Row) -> None:
    """``batch_items`` cannot hold folder images (FK to ``images``), so a
    dataset batch keeps every item in its project and never uses this table."""
    if row["kind"] == "dataset":
        raise BatchDatasetItemsInProjectError(int(row["id"]))


def _touch(conn: sqlite3.Connection, batch_id: int) -> None:
    conn.execute(f"UPDATE batches SET updated_at = {_NOW} WHERE id = ?", (batch_id,))


def _item_rows(conn: sqlite3.Connection, batch_id: int) -> list[dict[str, Any]]:
    rows = conn.execute(
        f"""
        SELECT {_ITEM_COLUMNS}
        FROM batch_items bi JOIN images i ON i.id = bi.image_id
        WHERE bi.batch_id = ?
        ORDER BY bi.position, bi.image_id
        """,
        (batch_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def _item_ids(conn: sqlite3.Connection, batch_id: int) -> list[int]:
    return [
        int(row[0])
        for row in conn.execute(
            "SELECT image_id FROM batch_items WHERE batch_id = ? ORDER BY position, image_id",
            (batch_id,),
        ).fetchall()
    ]


def _write_positions(
    conn: sqlite3.Connection, batch_id: int, ordered: list[int]
) -> None:
    conn.executemany(
        "UPDATE batch_items SET position = ? WHERE batch_id = ? AND image_id = ?",
        [(position, batch_id, image_id) for position, image_id in enumerate(ordered)],
    )


def _require_library_images(conn: sqlite3.Connection, image_ids: list[int]) -> None:
    found: set[int] = set()
    lib_sql, lib_params = current_library_sql()
    for chunk in _chunks(image_ids):
        placeholders = ",".join("?" for _ in chunk)
        rows = conn.execute(
            f"SELECT id FROM images WHERE id IN ({placeholders}) AND {lib_sql}",
            (*chunk, *lib_params),
        ).fetchall()
        found.update(int(row[0]) for row in rows)
    missing = [
        image_id for image_id in dict.fromkeys(image_ids) if image_id not in found
    ]
    if missing:
        raise BatchImagesNotFoundError(missing)


def _append_items(
    conn: sqlite3.Connection, batch_id: int, image_ids: list[int]
) -> tuple[list[int], list[int]]:
    """Append in order; ids already present (or repeated) are reported as skipped."""
    _require_library_images(conn, image_ids)
    present = set(_item_ids(conn, batch_id))
    added: list[int] = []
    skipped: list[int] = []
    for image_id in image_ids:
        if image_id in present:
            skipped.append(image_id)
            continue
        present.add(image_id)
        added.append(image_id)
    # MAX + 1, not COUNT: an image row deleted from the Library leaves a gap.
    start = int(
        conn.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM batch_items WHERE batch_id = ?",
            (batch_id,),
        ).fetchone()[0]
    )
    conn.executemany(
        "INSERT INTO batch_items (batch_id, image_id, position) VALUES (?, ?, ?)",
        [(batch_id, image_id, start + offset) for offset, image_id in enumerate(added)],
    )
    return added, skipped


def read_batch(batch_id: int) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    with get_db() as conn:
        return dict(_batch_row(conn, batch_id)), _item_rows(conn, batch_id)


def read_batch_view(
    batch_id: int,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """The batch row as the user sees it (a dataset batch shows its project)."""
    with get_db() as conn:
        row = dict(_batch_row(conn, batch_id))
        items = _item_rows(conn, batch_id)
        project_ids = (
            [int(row["dataset_project_id"])] if row["dataset_project_id"] else []
        )
        projects = project_summaries(conn, project_ids)
    row["cover_image_ids"] = [int(item["image_id"]) for item in items][
        :COVER_IMAGE_COUNT
    ]
    return with_project(row, projects), items


def with_project(
    row: dict[str, Any], projects: dict[int, dict[str, Any]]
) -> dict[str, Any]:
    """A dataset batch shows its project's name, archive state, items and covers.

    The project is the single source of truth (V3.5 edits it too). Once V3.5
    deletes it, the FK clears the link and the batch is ``orphaned``: it keeps
    its last known name and has no items.
    """
    view = {**row, "project_revision": None, "orphaned": False}
    if row["kind"] != "dataset":
        return view
    project_id = row["dataset_project_id"]
    project = projects.get(int(project_id)) if project_id else None
    if project is None:
        return {**view, "orphaned": True, "item_count": 0, "cover_image_ids": []}
    return {
        **view,
        "name": project["name"],
        "archived_at": project["archived_at"],
        "updated_at": max(row["updated_at"], project["updated_at"]),
        "project_revision": int(project["revision"]),
        "item_count": int(project["item_count"]),
        "censored_count": 0,
        "cover_image_ids": project["cover_image_ids"],
    }


def _source_collection_id(settings_json: str) -> int | None:
    """The V3.5 collection a custom batch was made from (D19), if any."""
    try:
        value = json.loads(settings_json).get("source_collection_id")
    except (ValueError, AttributeError):
        return None
    return value if type(value) is int else None


def list_batches(include_archived: bool, kind: str | None) -> list[dict[str, Any]]:
    lib_sql, lib_params = current_library_sql("b.library_id")
    clauses = [lib_sql]
    params: list[Any] = list(lib_params)
    if not include_archived:
        # A dataset batch's archive state is its project's (filtered below).
        clauses.append("(b.kind = 'dataset' OR b.archived_at IS NULL)")
    if kind:
        clauses.append("b.kind = ?")
        params.append(kind)
    with get_db() as conn:
        rows = conn.execute(
            f"""
            SELECT b.id, b.kind, b.name, b.current_step, b.revision, b.archived_at,
                   b.created_at, b.updated_at, b.dataset_project_id, b.settings_json,
                   COUNT(bi.image_id) AS item_count,
                   COALESCE(SUM(CASE WHEN bi.censored_path IS NOT NULL THEN 1 ELSE 0 END), 0)
                       AS censored_count
            FROM batches b LEFT JOIN batch_items bi ON bi.batch_id = b.id
            WHERE {" AND ".join(clauses)}
            GROUP BY b.id
            """,
            params,
        ).fetchall()
        summaries = [dict(row) for row in rows]
        covers = _cover_ids(conn, [int(row["id"]) for row in summaries])
        projects = project_summaries(
            conn,
            [
                int(row["dataset_project_id"])
                for row in summaries
                if row["dataset_project_id"]
            ],
        )
    views = []
    for summary in summaries:
        summary["cover_image_ids"] = covers.get(int(summary["id"]), [])
        summary["source_collection_id"] = _source_collection_id(
            summary.pop("settings_json")
        )
        view = with_project(summary, projects)
        if include_archived or view["archived_at"] is None:
            views.append(view)
    views.sort(key=lambda view: (view["updated_at"], view["id"]), reverse=True)
    return views


def project_summaries(
    conn: sqlite3.Connection, project_ids: list[int]
) -> dict[int, dict[str, Any]]:
    """Name, revision, archive state, item count and covers of this library's projects."""
    lib_sql, lib_params = current_library_sql("p.library_id")
    summaries: dict[int, dict[str, Any]] = {}
    for chunk in _chunks(project_ids):
        placeholders = ",".join("?" for _ in chunk)
        rows = conn.execute(
            f"""
            SELECT p.id, p.name, p.revision, p.archived_at, p.created_at, p.updated_at,
                   (SELECT COUNT(*) FROM dataset_project_items i
                    WHERE i.project_id = p.id) AS item_count
            FROM dataset_projects p
            WHERE p.id IN ({placeholders}) AND {lib_sql}
            """,
            (*chunk, *lib_params),
        ).fetchall()
        summaries.update({int(row["id"]): dict(row) for row in rows})
    covers = _project_cover_ids(conn, list(summaries))
    for project_id, summary in summaries.items():
        summary["cover_image_ids"] = covers.get(project_id, [])
    return summaries


def _project_cover_ids(
    conn: sqlite3.Connection, project_ids: list[int]
) -> dict[int, list[int]]:
    """First Library images of each project in order; folder images have no id."""
    covers: dict[int, list[int]] = {}
    for chunk in _chunks(project_ids):
        placeholders = ",".join("?" for _ in chunk)
        rows = conn.execute(
            f"""
            SELECT project_id, image_id FROM (
                SELECT project_id, image_id, ROW_NUMBER() OVER (
                    PARTITION BY project_id ORDER BY position
                ) AS rn
                FROM dataset_project_items
                WHERE project_id IN ({placeholders}) AND image_id IS NOT NULL
            ) WHERE rn <= ? ORDER BY project_id, rn
            """,
            (*chunk, COVER_IMAGE_COUNT),
        ).fetchall()
        for row in rows:
            covers.setdefault(int(row[0]), []).append(int(row[1]))
    return covers


def _cover_ids(conn: sqlite3.Connection, batch_ids: list[int]) -> dict[int, list[int]]:
    covers: dict[int, list[int]] = {}
    for chunk in _chunks(batch_ids):
        placeholders = ",".join("?" for _ in chunk)
        rows = conn.execute(
            f"""
            SELECT batch_id, image_id FROM (
                SELECT batch_id, image_id, ROW_NUMBER() OVER (
                    PARTITION BY batch_id ORDER BY position, image_id
                ) AS rn
                FROM batch_items WHERE batch_id IN ({placeholders})
            ) WHERE rn <= ? ORDER BY batch_id, rn
            """,
            (*chunk, COVER_IMAGE_COUNT),
        ).fetchall()
        for row in rows:
            covers.setdefault(int(row[0]), []).append(int(row[1]))
    return covers


def create_batch(
    kind: str,
    name: str,
    steps_json: str,
    settings_json: str,
    current_step: str | None,
    image_ids: list[int],
) -> tuple[int, list[int]]:
    with get_db() as conn:
        _begin_write(conn)
        _require_library_images(conn, image_ids)
        batch_id = int(
            conn.execute(
                """
                INSERT INTO batches (library_id, kind, name, steps_json, settings_json, current_step)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    get_current_library_id(),
                    kind,
                    name,
                    steps_json,
                    settings_json,
                    current_step,
                ),
            ).lastrowid
        )
        _added, skipped = _append_items(conn, batch_id, image_ids)
        return batch_id, skipped


def update_batch(batch_id: int, expected_revision: int, fields: dict[str, Any]) -> None:
    """Compare-and-set the batch row's own fields (name, steps, settings...)."""
    with get_db() as conn:
        _begin_write(conn)
        _update_batch_row(conn, batch_id, expected_revision, fields)


def _update_batch_row(
    conn: sqlite3.Connection,
    batch_id: int,
    expected_revision: int,
    fields: dict[str, Any],
) -> None:
    """The compare-and-set of ``update_batch`` inside the caller's transaction."""
    allowed = {"name", "steps_json", "settings_json", "current_step", "archived"}
    unknown = set(fields) - allowed
    if unknown:
        raise ValueError(f"Unknown batch fields: {sorted(unknown)}")
    assignments: list[str] = []
    params: list[Any] = []
    for column in ("name", "steps_json", "settings_json", "current_step"):
        if column in fields:
            assignments.append(f"{column} = ?")
            params.append(fields[column])
    if "archived" in fields:
        assignments.append(
            f"archived_at = {_NOW}" if fields["archived"] else "archived_at = NULL"
        )
    assignments.extend(["revision = revision + 1", f"updated_at = {_NOW}"])
    row = _batch_row(conn, batch_id)
    cursor = conn.execute(
        f"UPDATE batches SET {', '.join(assignments)} WHERE id = ? AND revision = ?",
        (*params, batch_id, expected_revision),
    )
    if cursor.rowcount != 1:
        raise BatchRevisionConflictError(
            batch_id, expected_revision, int(row["revision"])
        )


def delete_batch(batch_id: int, expected_project_revision: int | None = None) -> None:
    """Delete the batch; a dataset batch takes its project with it (D30).

    The project cascade removes its items, folder-image references and every
    caption subject, revision and head. Library rows and image files (Library
    or folder) are never touched. With ``expected_project_revision`` a project
    changed since the user confirmed (by V3.5, say) is not deleted.
    """
    with get_db() as conn:
        _begin_write(conn)
        row = _batch_row(conn, batch_id)
        project_id = row["dataset_project_id"]
        if project_id is not None and expected_project_revision is not None:
            _require_project_revision(conn, int(project_id), expected_project_revision)
        conn.execute("DELETE FROM batches WHERE id = ?", (batch_id,))
        if project_id is not None:
            conn.execute(
                "DELETE FROM dataset_projects WHERE id = ?", (int(project_id),)
            )


def _require_project_revision(
    conn: sqlite3.Connection, project_id: int, expected_revision: int
) -> None:
    row = conn.execute(
        "SELECT revision FROM dataset_projects WHERE id = ?", (project_id,)
    ).fetchone()
    current = int(row[0]) if row is not None else 0
    if current != expected_revision:
        raise BatchProjectRevisionConflictError(project_id, expected_revision, current)


def add_items(batch_id: int, image_ids: list[int]) -> tuple[list[int], list[int]]:
    with get_db() as conn:
        _begin_write(conn)
        _require_own_items(_batch_row(conn, batch_id))
        added, skipped = _append_items(conn, batch_id, image_ids)
        _touch(conn, batch_id)
        return added, skipped


def remove_items(batch_id: int, image_ids: list[int]) -> tuple[list[int], list[int]]:
    with get_db() as conn:
        _begin_write(conn)
        _require_own_items(_batch_row(conn, batch_id))
        current = _item_ids(conn, batch_id)
        present = set(current)
        requested = list(dict.fromkeys(image_ids))
        removed = [image_id for image_id in requested if image_id in present]
        not_found = [image_id for image_id in requested if image_id not in present]
        conn.executemany(
            "DELETE FROM batch_items WHERE batch_id = ? AND image_id = ?",
            [(batch_id, image_id) for image_id in removed],
        )
        removed_set = set(removed)
        _write_positions(conn, batch_id, [i for i in current if i not in removed_set])
        _touch(conn, batch_id)
        return removed, not_found


def reorder_items(batch_id: int, ordered_ids: list[int]) -> None:
    with get_db() as conn:
        _begin_write(conn)
        _require_own_items(_batch_row(conn, batch_id))
        current = set(_item_ids(conn, batch_id))
        requested = set(ordered_ids)
        if requested != current:
            raise BatchItemsMismatchError(
                sorted(current - requested),
                [i for i in ordered_ids if i not in current],
            )
        _write_positions(conn, batch_id, ordered_ids)
        _touch(conn, batch_id)


def read_item(batch_id: int, image_id: int) -> dict[str, Any]:
    with get_db() as conn:
        _batch_row(conn, batch_id)
        return _require_item(conn, batch_id, image_id)


def _require_item(
    conn: sqlite3.Connection, batch_id: int, image_id: int
) -> dict[str, Any]:
    row = conn.execute(
        f"""
        SELECT {_ITEM_COLUMNS}
        FROM batch_items bi JOIN images i ON i.id = bi.image_id
        WHERE bi.batch_id = ? AND bi.image_id = ?
        """,
        (batch_id, image_id),
    ).fetchone()
    if row is None:
        raise BatchItemNotFoundError(batch_id, image_id)
    return dict(row)


def update_item(
    batch_id: int,
    image_id: int,
    fields: dict[str, Any],
    before_commit: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Set per-item columns: output_name, item_state_json, censored_path/_at.

    ``before_commit`` runs inside the write transaction after the row changed;
    if it raises, nothing is committed (a file swap that must match the row).
    """
    allowed = {"output_name", "item_state_json", "censored_path"}
    unknown = set(fields) - allowed
    if unknown:
        raise ValueError(f"Unknown batch item fields: {sorted(unknown)}")
    assignments = [f"{column} = ?" for column in fields]
    params = list(fields.values())
    if "censored_path" in fields:
        assignments.append(
            f"censored_at = {_NOW}" if fields["censored_path"] else "censored_at = NULL"
        )
    with get_db() as conn:
        _begin_write(conn)
        _batch_row(conn, batch_id)
        _require_item(conn, batch_id, image_id)
        if assignments:
            conn.execute(
                f"UPDATE batch_items SET {', '.join(assignments)} "
                "WHERE batch_id = ? AND image_id = ?",
                (*params, batch_id, image_id),
            )
        _touch(conn, batch_id)
        row = _require_item(conn, batch_id, image_id)
        if before_commit is not None:
            before_commit()
        return row


def list_templates(kind: str | None) -> list[dict[str, Any]]:
    lib_sql, lib_params = current_library_sql()
    params: list[Any] = list(lib_params)
    kind_sql = ""
    if kind:
        kind_sql = " AND kind = ?"
        params.append(kind)
    with get_db() as conn:
        rows = conn.execute(
            f"SELECT * FROM batch_templates WHERE {lib_sql}{kind_sql} ORDER BY name, id",
            params,
        ).fetchall()
    return [dict(row) for row in rows]


def read_template(template_id: int) -> dict[str, Any]:
    lib_sql, lib_params = current_library_sql()
    with get_db() as conn:
        row = conn.execute(
            f"SELECT * FROM batch_templates WHERE id = ? AND {lib_sql}",
            (template_id, *lib_params),
        ).fetchone()
    if row is None:
        raise BatchTemplateNotFoundError(template_id)
    return dict(row)


def create_template(kind: str, name: str, steps_json: str, settings_json: str) -> int:
    with get_db() as conn:
        return int(
            conn.execute(
                """
                INSERT INTO batch_templates (library_id, kind, name, steps_json, settings_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (get_current_library_id(), kind, name, steps_json, settings_json),
            ).lastrowid
        )


def delete_template(template_id: int) -> None:
    lib_sql, lib_params = current_library_sql()
    with get_db() as conn:
        cursor = conn.execute(
            f"DELETE FROM batch_templates WHERE id = ? AND {lib_sql}",
            (template_id, *lib_params),
        )
        if cursor.rowcount != 1:
            raise BatchTemplateNotFoundError(template_id)
