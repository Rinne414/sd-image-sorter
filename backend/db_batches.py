"""Transactional persistence for V4 batches (migration 060).

Every query is pinned to the request's library (``X-SD-Library-Id``): a batch
or template of another library behaves exactly like one that does not exist.
``revision`` guards the batch row's own fields (name, steps, settings, current
step, archive state); item operations validate themselves and only touch
``updated_at``.
"""

from __future__ import annotations

import sqlite3
from typing import Any

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


def list_batches(include_archived: bool, kind: str | None) -> list[dict[str, Any]]:
    lib_sql, lib_params = current_library_sql("b.library_id")
    clauses = [lib_sql]
    params: list[Any] = list(lib_params)
    if not include_archived:
        clauses.append("b.archived_at IS NULL")
    if kind:
        clauses.append("b.kind = ?")
        params.append(kind)
    with get_db() as conn:
        rows = conn.execute(
            f"""
            SELECT b.id, b.kind, b.name, b.current_step, b.revision, b.archived_at,
                   b.created_at, b.updated_at,
                   COUNT(bi.image_id) AS item_count,
                   COALESCE(SUM(CASE WHEN bi.censored_path IS NOT NULL THEN 1 ELSE 0 END), 0)
                       AS censored_count
            FROM batches b LEFT JOIN batch_items bi ON bi.batch_id = b.id
            WHERE {" AND ".join(clauses)}
            GROUP BY b.id
            ORDER BY b.updated_at DESC, b.id DESC
            """,
            params,
        ).fetchall()
        summaries = [dict(row) for row in rows]
        covers = _cover_ids(conn, [int(row["id"]) for row in summaries])
    for summary in summaries:
        summary["cover_image_ids"] = covers.get(int(summary["id"]), [])
    return summaries


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
    with get_db() as conn:
        _begin_write(conn)
        row = _batch_row(conn, batch_id)
        cursor = conn.execute(
            f"UPDATE batches SET {', '.join(assignments)} WHERE id = ? AND revision = ?",
            (*params, batch_id, expected_revision),
        )
        if cursor.rowcount != 1:
            raise BatchRevisionConflictError(
                batch_id, expected_revision, int(row["revision"])
            )


def delete_batch(batch_id: int) -> None:
    with get_db() as conn:
        _begin_write(conn)
        _batch_row(conn, batch_id)
        conn.execute("DELETE FROM batches WHERE id = ?", (batch_id,))


def add_items(batch_id: int, image_ids: list[int]) -> tuple[list[int], list[int]]:
    with get_db() as conn:
        _begin_write(conn)
        _batch_row(conn, batch_id)
        added, skipped = _append_items(conn, batch_id, image_ids)
        _touch(conn, batch_id)
        return added, skipped


def remove_items(batch_id: int, image_ids: list[int]) -> tuple[list[int], list[int]]:
    with get_db() as conn:
        _begin_write(conn)
        _batch_row(conn, batch_id)
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
        _batch_row(conn, batch_id)
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


def update_item(batch_id: int, image_id: int, fields: dict[str, Any]) -> dict[str, Any]:
    """Set per-item columns: output_name, item_state_json, censored_path/_at."""
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
        return _require_item(conn, batch_id, image_id)


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
