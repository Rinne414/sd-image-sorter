"""Copy a dataset batch ("Save as…", V4 slice 6n5, D55).

The copy is a new dataset batch with its own Dataset Maker project: the same
items in the same order, the same V1 settings, the batch's V4 shell (steps,
current step, V4-only settings) and every training caption with its whole
history. Captions are copied as new subjects, revisions and heads of the new
project, never shared with the original, and each revision keeps its content,
source, author (an AI caption stays AI-written), provider, model and time.

Files uploaded into the source batch live in its own ``uploads/`` folder and go
when that batch is deleted, so they are copied: first into a staging folder,
then moved into the new batch's folder inside the database transaction, before
it commits. If anything fails, the transaction rolls back and every file this
copy wrote is removed, so a failed copy leaves nothing behind. Folder images
outside the uploads folder and Library images are referenced, as the source
references them. No schema change; V3.5 sees the copy as one more project.
"""

from __future__ import annotations

import logging
import os
import shutil
import sqlite3
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import db_batch_datasets as dataset_db
import db_batches as batch_db
from db_annotation_revisions import _local_subject_key
from db_core import get_db
from library_context import get_current_library_id
from services import batch_service, batch_workdir
from utils.source_paths import indexed_image_path_match_key

logger = logging.getLogger(__name__)

# (path_key, size, mtime_ns, device, inode): how a folder file is identified.
Identity = tuple[str, int, str, str, str]


class BatchCopySourceChangedError(batch_db.BatchError):
    def __init__(self, batch_id: int):
        self.batch_id = batch_id
        super().__init__(
            f"Batch {batch_id} changed while it was being copied; copy it again"
        )


@dataclass(frozen=True)
class _Source:
    batch_id: int
    project_id: int
    project_revision: int
    # uploaded files: local source id -> path inside the uploads folder
    uploads: dict[int, Path]
    # their path keys (any caption subject of an uploaded file carries one)
    upload_keys: frozenset[str]


def copy_dataset_batch(batch_id: int, name: str) -> dict[str, Any]:
    """Copy a dataset batch of the current library under ``name``; the new batch."""
    source = _read_source(batch_id)
    staging = batch_workdir.batches_root() / f".copy-{uuid.uuid4().hex}"
    created: list[Path] = []
    try:
        _stage_uploads(source, staging)
        with get_db() as conn:
            batch_db._begin_write(conn)
            new_batch_id = _write_copy(conn, source, name.strip(), staging, created)
    except BaseException:
        for folder in created:
            _remove_folder(folder)
        raise
    finally:
        _remove_folder(staging)
    return {"batch": batch_service.get_batch(new_batch_id)}


def _read_source(batch_id: int) -> _Source:
    with get_db() as conn:
        row = batch_db._batch_row(conn, batch_id)
        project_id = _project_of(row)
        revision = conn.execute(
            "SELECT revision FROM dataset_projects WHERE id = ?", (project_id,)
        ).fetchone()
        if revision is None:
            raise dataset_db.BatchDatasetOrphanedError(batch_id)
        sources = conn.execute(
            "SELECT id, path, path_key FROM dataset_project_local_sources WHERE project_id = ?",
            (project_id,),
        ).fetchall()
    folder = batch_workdir.uploads_folder(batch_id).resolve()
    uploads: dict[int, Path] = {}
    upload_keys: set[str] = set()
    for source in sources:
        relative = _inside(str(source["path"]), folder)
        if relative is not None:
            uploads[int(source["id"])] = relative
            upload_keys.add(str(source["path_key"]))
    return _Source(
        batch_id, project_id, int(revision["revision"]), uploads, frozenset(upload_keys)
    )


def _project_of(row: sqlite3.Row) -> int:
    if row["kind"] != "dataset":
        raise dataset_db.BatchNotDatasetError(int(row["id"]))
    if row["dataset_project_id"] is None:
        raise dataset_db.BatchDatasetOrphanedError(int(row["id"]))
    return int(row["dataset_project_id"])


def _inside(path: str, folder: Path) -> Path | None:
    try:
        return Path(path).resolve().relative_to(folder)
    except (OSError, ValueError):
        return None


def _stage_uploads(source: _Source, staging: Path) -> None:
    """Copy the uploaded files that are still there (a gone one stays gone)."""
    folder = batch_workdir.uploads_folder(source.batch_id)
    for relative in source.uploads.values():
        original = folder / relative
        if not original.is_file():
            continue
        target = staging / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(original, target)


def _write_copy(
    conn: sqlite3.Connection,
    source: _Source,
    name: str,
    staging: Path,
    created: list[Path],
) -> int:
    row = batch_db._batch_row(conn, source.batch_id)
    project = conn.execute(
        "SELECT revision, settings_json FROM dataset_projects WHERE id = ?",
        (source.project_id,),
    ).fetchone()
    if (
        _project_of(row) != source.project_id
        or project is None
        or int(project["revision"]) != source.project_revision
    ):
        raise BatchCopySourceChangedError(source.batch_id)
    dataset_db._require_name_free(conn, name, None)
    new_project_id = int(
        conn.execute(
            """
            INSERT INTO dataset_projects (name, name_key, settings_json, library_id)
            VALUES (?, ?, ?, ?)
            """,
            (name, name.casefold(), project["settings_json"], get_current_library_id()),
        ).lastrowid
    )
    shell = {key: row[key] for key in ("steps_json", "settings_json", "current_step")}
    new_batch_id = dataset_db._insert_batch(conn, shell, name, new_project_id, None)
    uploads_folder = _place_uploads(new_batch_id, staging, created)
    moved = _copy_items(conn, source, new_project_id, uploads_folder)
    _copy_captions(conn, source, new_project_id, moved)
    return new_batch_id


def _place_uploads(new_batch_id: int, staging: Path, created: list[Path]) -> Path:
    """Move the staged files into the new batch's folder (inside the transaction)."""
    # A restored older database can hand out an id whose folder is still on disk;
    # no row points at it (the same cleanup as creating a batch).
    batch_workdir.remove_batch_folder(new_batch_id)
    uploads = batch_workdir.uploads_folder(new_batch_id)
    if staging.is_dir():
        folder = batch_workdir.batch_folder(new_batch_id)
        folder.mkdir(parents=True)
        created.append(folder)
        os.replace(staging, uploads)
    return uploads


def _file_identity(path: Path) -> Identity:
    stat = os.stat(path)
    return (
        indexed_image_path_match_key(str(path)),
        stat.st_size,
        str(stat.st_mtime_ns),
        str(stat.st_dev),
        str(stat.st_ino),
    )


def _copy_items(
    conn: sqlite3.Connection,
    source: _Source,
    new_project_id: int,
    uploads_folder: Path,
) -> dict[Identity, tuple[str, Identity]]:
    """Copy the items in order; the uploaded files' old identity -> (new path, new identity)."""
    rows = conn.execute(
        """
        SELECT i.position, i.item_type, i.source_image_id, i.image_id,
               s.id AS source_id, s.path, s.path_key, s.size, s.mtime_ns,
               s.device, s.inode
        FROM dataset_project_items i
        LEFT JOIN dataset_project_local_sources s
            ON s.id = i.local_source_id AND s.project_id = i.project_id
        WHERE i.project_id = ?
        ORDER BY i.position
        """,
        (source.project_id,),
    ).fetchall()
    moved: dict[Identity, tuple[str, Identity]] = {}
    for row in rows:
        if row["item_type"] == "library":
            conn.execute(
                """
                INSERT INTO dataset_project_items (
                    project_id, position, item_type, source_image_id, image_id,
                    local_source_id
                ) VALUES (?, ?, 'library', ?, ?, NULL)
                """,
                (
                    new_project_id,
                    row["position"],
                    row["source_image_id"],
                    row["image_id"],
                ),
            )
            continue
        path, identity = _local_copy(row, source.uploads, uploads_folder, moved)
        _insert_local_item(conn, new_project_id, int(row["position"]), path, identity)
    return moved


def _local_copy(
    row: sqlite3.Row,
    uploads: dict[int, Path],
    uploads_folder: Path,
    moved: dict[Identity, tuple[str, Identity]],
) -> tuple[str, Identity]:
    """A folder item's path and identity in the copy: uploaded files move to the new folder."""
    old: Identity = (
        str(row["path_key"]),
        int(row["size"]),
        str(row["mtime_ns"]),
        str(row["device"]),
        str(row["inode"]),
    )
    relative = uploads.get(int(row["source_id"]))
    if relative is None:
        return str(row["path"]), old
    new_path = (uploads_folder / relative).resolve()
    if not new_path.is_file():
        # The uploaded file was already gone: the copy lists it as missing too.
        return str(new_path), (indexed_image_path_match_key(str(new_path)), *old[1:])
    identity = _file_identity(new_path)
    moved[old] = (str(new_path), identity)
    return str(new_path), identity


def _insert_local_item(
    conn: sqlite3.Connection,
    project_id: int,
    position: int,
    path: str,
    identity: Identity,
) -> None:
    local_source_id = conn.execute(
        """
        INSERT INTO dataset_project_local_sources (
            project_id, path, path_key, size, mtime_ns, device, inode
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (project_id, path, *identity),
    ).lastrowid
    conn.execute(
        """
        INSERT INTO dataset_project_items (
            project_id, position, item_type, source_image_id, image_id,
            local_source_id
        ) VALUES (?, ?, 'local', NULL, NULL, ?)
        """,
        (project_id, position, local_source_id),
    )


_SUBJECT_COLUMNS = (
    "subject_kind",
    "subject_key",
    "library_source_image_id",
    "library_path_key",
    "library_size",
    "library_mtime_ns",
    "library_device",
    "library_inode",
    "local_path",
    "local_path_key",
    "local_size",
    "local_mtime_ns",
    "local_device",
    "local_inode",
    "created_at",
)


def _copy_captions(
    conn: sqlite3.Connection,
    source: _Source,
    new_project_id: int,
    moved: dict[Identity, tuple[str, Identity]],
) -> None:
    """Every caption subject with its whole history and head, as new rows."""
    for subject in conn.execute(
        "SELECT * FROM annotation_subjects WHERE project_id = ? ORDER BY id",
        (source.project_id,),
    ).fetchall():
        values = _subject_values(subject, moved, source.upload_keys)
        if values is None:
            continue
        new_subject_id = conn.execute(
            f"""
            INSERT INTO annotation_subjects (project_id, {", ".join(_SUBJECT_COLUMNS)})
            VALUES (?, {", ".join("?" for _ in _SUBJECT_COLUMNS)})
            """,
            (new_project_id, *(values[column] for column in _SUBJECT_COLUMNS)),
        ).lastrowid
        _copy_history(conn, int(subject["id"]), int(new_subject_id))


def _subject_values(
    subject: sqlite3.Row,
    moved: dict[Identity, tuple[str, Identity]],
    upload_keys: frozenset[str],
) -> dict[str, Any] | None:
    """The subject's columns in the copy; None when it names no file the copy has."""
    values = {column: subject[column] for column in _SUBJECT_COLUMNS}
    if subject["subject_kind"] != "project_local":
        return values
    old: Identity = (
        str(subject["local_path_key"]),
        int(subject["local_size"]),
        str(subject["local_mtime_ns"]),
        str(subject["local_device"]),
        str(subject["local_inode"]),
    )
    if old not in moved:
        # A folder image outside the uploads folder is referenced as it is; an
        # uploaded file that is gone, or an older version of one, has no file
        # in the copy to point at (and must not point into the original's folder).
        return None if old[0] in upload_keys else values
    path, (path_key, size, mtime_ns, device, inode) = moved[old]
    values.update(
        subject_key=_local_subject_key(path_key, size, mtime_ns, device, inode),
        local_path=path,
        local_path_key=path_key,
        local_size=size,
        local_mtime_ns=mtime_ns,
        local_device=device,
        local_inode=inode,
    )
    return values


def _copy_history(
    conn: sqlite3.Connection, subject_id: int, new_subject_id: int
) -> None:
    """Each revision as it was written (content, source, author, provider, model,
    time), linked to its own copied parent; then the head, pointing at the copies."""
    copied: dict[int, int] = {}
    for revision in conn.execute(
        "SELECT * FROM annotation_revisions WHERE subject_id = ? ORDER BY id",
        (subject_id,),
    ).fetchall():
        copied[int(revision["id"])] = int(
            conn.execute(
                """
                INSERT INTO annotation_revisions (
                    subject_id, annotation_kind, parent_revision_id,
                    restored_from_revision_id, content_json, content_sha256,
                    source_kind, author_class, provider, model, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    new_subject_id,
                    revision["annotation_kind"],
                    _mapped(copied, revision["parent_revision_id"]),
                    _mapped(copied, revision["restored_from_revision_id"]),
                    revision["content_json"],
                    revision["content_sha256"],
                    revision["source_kind"],
                    revision["author_class"],
                    revision["provider"],
                    revision["model"],
                    revision["created_at"],
                ),
            ).lastrowid
        )
    for head in conn.execute(
        "SELECT * FROM annotation_heads WHERE subject_id = ?", (subject_id,)
    ).fetchall():
        conn.execute(
            """
            INSERT INTO annotation_heads (
                subject_id, annotation_kind, active_revision_id,
                reviewed_revision_id, export_revision_id, generation
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                new_subject_id,
                head["annotation_kind"],
                _mapped(copied, head["active_revision_id"]),
                _mapped(copied, head["reviewed_revision_id"]),
                _mapped(copied, head["export_revision_id"]),
                head["generation"],
            ),
        )


def _mapped(copied: dict[int, int], revision_id: int | None) -> int | None:
    return None if revision_id is None else copied[int(revision_id)]


def _remove_folder(folder: Path) -> None:
    try:
        shutil.rmtree(folder)
    except FileNotFoundError:
        pass
    except OSError:
        logger.warning("Could not remove the copy's folder %s", folder, exc_info=True)
