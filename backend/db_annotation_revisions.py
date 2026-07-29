"""Immutable Dataset Project annotation revision persistence."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import stat
from collections.abc import Mapping
from typing import Literal, TypedDict, cast

from db_core import get_db
from utils.source_paths import (
    indexed_image_path_match_key,
    resolve_existing_indexed_image_path,
)


ANNOTATION_KIND_TRAINING_CAPTION = "training_caption"
_CONTENT_KEYS = frozenset(
    {
        "content_version",
        "booru_caption",
        "nl_caption",
        "caption_type",
    }
)
_CAPTION_TYPES = frozenset({"booru", "nl", "both"})
_SOURCE_KINDS = frozenset(
    {
        "legacy_snapshot",
        "manual",
        "metadata",
        "wd14",
        "vlm",
        "translation",
        "sidecar_import",
        "restore",
    }
)
_AUTHOR_CLASSES = frozenset({"system", "user", "ai", "import"})
_HEAD_COLUMNS = {
    "active": "active_revision_id",
    "reviewed": "reviewed_revision_id",
    "export": "export_revision_id",
}
_MAX_CAPTION_LENGTH = 20_000
_MAX_PROVENANCE_LENGTH = 512

AnnotationSubjectKind = Literal["project_library", "project_local"]
AnnotationSourceKind = Literal[
    "legacy_snapshot",
    "manual",
    "metadata",
    "wd14",
    "vlm",
    "translation",
    "sidecar_import",
    "restore",
]
AnnotationAuthorClass = Literal["system", "user", "ai", "import"]
AnnotationHeadKind = Literal["active", "reviewed", "export"]
CaptionType = Literal["booru", "nl", "both"]


class TrainingCaptionContent(TypedDict):
    content_version: Literal[1]
    booru_caption: str
    nl_caption: str
    caption_type: CaptionType


class AnnotationSubjectRecord(TypedDict):
    id: int
    project_id: int
    subject_kind: AnnotationSubjectKind
    subject_key: str
    library_source_image_id: int | None
    library_path_key: str | None
    library_size: int | None
    library_mtime_ns: str | None
    library_device: str | None
    library_inode: str | None
    local_path: str | None
    local_path_key: str | None
    local_size: int | None
    local_mtime_ns: str | None
    local_device: str | None
    local_inode: str | None
    created_at: str


class AnnotationRevisionRecord(TypedDict):
    id: int
    subject_id: int
    annotation_kind: Literal["training_caption"]
    parent_revision_id: int | None
    restored_from_revision_id: int | None
    content: TrainingCaptionContent
    content_json: str
    content_sha256: str
    source_kind: AnnotationSourceKind
    author_class: AnnotationAuthorClass
    provider: str | None
    model: str | None
    created_at: str


class AnnotationHeadRecord(TypedDict):
    subject_id: int
    annotation_kind: Literal["training_caption"]
    active_revision_id: int | None
    reviewed_revision_id: int | None
    export_revision_id: int | None
    generation: int


class AnnotationMutationRecord(TypedDict):
    subject: AnnotationSubjectRecord
    revision: AnnotationRevisionRecord
    head: AnnotationHeadRecord


class FileIdentityRecord(TypedDict):
    path: str
    path_key: str
    size: int
    mtime_ns: str
    device: str
    inode: str


class AnnotationRevisionPage(TypedDict):
    items: list[AnnotationRevisionRecord]
    has_more: bool
    next_before_revision_id: int | None


class ProjectTrainingCaptionHeadItem(TypedDict):
    subject: AnnotationSubjectRecord
    head: AnnotationHeadRecord
    active_revision: AnnotationRevisionRecord


class ProjectTrainingCaptionHeadPage(TypedDict):
    items: list[ProjectTrainingCaptionHeadItem]
    has_more: bool
    next_after_subject_id: int | None


class ResolvedAnnotationHeadRecord(TypedDict):
    subject_key: str
    subject: AnnotationSubjectRecord | None
    head: AnnotationHeadRecord | None
    active_revision: AnnotationRevisionRecord | None
    generation: int


class AnnotationRevisionError(RuntimeError):
    """Base class for expected annotation ledger failures."""


class AnnotationContentValidationError(AnnotationRevisionError):
    def __init__(self, field: str, reason: str):
        self.field = field
        self.reason = reason
        super().__init__(f"Training caption {field} is invalid: {reason}")


class AnnotationProjectNotFoundError(AnnotationRevisionError):
    def __init__(self, project_id: int):
        self.project_id = project_id
        super().__init__(f"Dataset project {project_id} was not found")


class AnnotationProjectRevisionConflictError(AnnotationRevisionError):
    def __init__(self, project_id: int, expected_revision: int, current_revision: int):
        self.project_id = project_id
        self.expected_revision = expected_revision
        self.current_revision = current_revision
        super().__init__(
            f"Dataset project {project_id} revision conflict: expected "
            f"{expected_revision}, current {current_revision}"
        )


class AnnotationProjectStateConflictError(AnnotationRevisionError):
    def __init__(self, project_id: int, state: str):
        self.project_id = project_id
        self.state = state
        super().__init__(
            f"Dataset project {project_id} is {state} and cannot change annotations"
        )


class AnnotationSubjectNotInProjectError(AnnotationRevisionError):
    def __init__(self, project_id: int, subject_kind: str, identifier: str):
        self.project_id = project_id
        self.subject_kind = subject_kind
        self.identifier = identifier
        super().__init__(
            f"Dataset project {project_id} has no current {subject_kind} subject "
            f"matching {identifier!r}"
        )


class AnnotationSubjectNotFoundError(AnnotationRevisionError):
    def __init__(self, subject_id: int):
        self.subject_id = subject_id
        super().__init__(f"Annotation subject {subject_id} was not found")


class AnnotationSubjectProjectConflictError(AnnotationRevisionError):
    def __init__(self, project_id: int, subject_id: int, actual_project_id: int):
        self.project_id = project_id
        self.subject_id = subject_id
        self.actual_project_id = actual_project_id
        super().__init__(
            f"Annotation subject {subject_id} belongs to Dataset project "
            f"{actual_project_id}, not {project_id}"
        )


class AnnotationSubjectIdentityConflictError(AnnotationRevisionError):
    def __init__(self, project_id: int, subject_id: int | None, path: str, reason: str):
        self.project_id = project_id
        self.subject_id = subject_id
        self.path = path
        self.reason = reason
        super().__init__(
            f"Dataset project {project_id} local annotation subject {path!r} "
            f"is invalid: {reason}"
        )


class AnnotationHeadConflictError(AnnotationRevisionError):
    def __init__(
        self, subject_id: int, expected_generation: int, current_generation: int
    ):
        self.subject_id = subject_id
        self.expected_generation = expected_generation
        self.current_generation = current_generation
        super().__init__(
            f"Annotation subject {subject_id} head conflict: expected generation "
            f"{expected_generation}, current {current_generation}"
        )


class AnnotationRevisionNotFoundError(AnnotationRevisionError):
    def __init__(self, revision_id: int):
        self.revision_id = revision_id
        super().__init__(f"Annotation revision {revision_id} was not found")


class AnnotationRevisionSubjectConflictError(AnnotationRevisionError):
    def __init__(self, subject_id: int, revision_id: int, actual_subject_id: int):
        self.subject_id = subject_id
        self.revision_id = revision_id
        self.actual_subject_id = actual_subject_id
        super().__init__(
            f"Annotation revision {revision_id} belongs to subject "
            f"{actual_subject_id}, not {subject_id}"
        )


def _require_strict_non_negative_int(value: int, field: str) -> int:
    if type(value) is not int or value < 0:
        raise AnnotationContentValidationError(
            field,
            "must be a non-negative integer",
        )
    return value


def _require_strict_positive_int(value: int, field: str) -> int:
    if type(value) is not int or value <= 0:
        raise AnnotationContentValidationError(field, "must be a positive integer")
    return value


def _canonical_training_caption_content(
    content: Mapping[str, object],
) -> tuple[TrainingCaptionContent, str, str]:
    if type(content) is not dict:
        raise AnnotationContentValidationError("content", "must be an object")
    keys = frozenset(content.keys())
    if keys != _CONTENT_KEYS:
        missing = sorted(_CONTENT_KEYS - keys)
        extra = sorted(keys - _CONTENT_KEYS)
        raise AnnotationContentValidationError(
            "content",
            f"requires exact fields; missing={missing}, extra={extra}",
        )
    content_version = content["content_version"]
    booru_caption = content["booru_caption"]
    nl_caption = content["nl_caption"]
    caption_type = content["caption_type"]
    if type(content_version) is not int or content_version != 1:
        raise AnnotationContentValidationError(
            "content_version",
            "must be the integer 1",
        )
    for field, value in (
        ("booru_caption", booru_caption),
        ("nl_caption", nl_caption),
    ):
        if type(value) is not str:
            raise AnnotationContentValidationError(field, "must be a string")
        if len(value) > _MAX_CAPTION_LENGTH:
            raise AnnotationContentValidationError(
                field,
                f"must be at most {_MAX_CAPTION_LENGTH} characters",
            )
    if type(caption_type) is not str or caption_type not in _CAPTION_TYPES:
        raise AnnotationContentValidationError(
            "caption_type",
            "must be booru, nl, or both",
        )
    normalized: TrainingCaptionContent = {
        "content_version": 1,
        "booru_caption": booru_caption,
        "nl_caption": nl_caption,
        "caption_type": cast(CaptionType, caption_type),
    }
    content_json = json.dumps(
        normalized,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    content_sha256 = hashlib.sha256(content_json.encode("utf-8")).hexdigest()
    return normalized, content_json, content_sha256


def _validate_provenance(
    source_kind: str,
    author_class: str,
    provider: str | None,
    model: str | None,
) -> tuple[AnnotationSourceKind, AnnotationAuthorClass, str | None, str | None]:
    if type(source_kind) is not str or source_kind not in _SOURCE_KINDS:
        raise AnnotationContentValidationError("source_kind", "is unsupported")
    if source_kind == "restore":
        raise AnnotationContentValidationError(
            "source_kind",
            "restore is reserved for the restore operation",
        )
    if type(author_class) is not str or author_class not in _AUTHOR_CLASSES:
        raise AnnotationContentValidationError("author_class", "is unsupported")
    for field, value in (("provider", provider), ("model", model)):
        if value is None:
            continue
        if type(value) is not str or not value or value != value.strip():
            raise AnnotationContentValidationError(
                field,
                "must be null or a non-empty trimmed string",
            )
        if len(value) > _MAX_PROVENANCE_LENGTH:
            raise AnnotationContentValidationError(
                field,
                f"must be at most {_MAX_PROVENANCE_LENGTH} characters",
            )
    return (
        cast(AnnotationSourceKind, source_kind),
        cast(AnnotationAuthorClass, author_class),
        provider,
        model,
    )


def _begin_write(conn: sqlite3.Connection) -> None:
    conn.execute("BEGIN IMMEDIATE")


def _require_project_for_write(
    conn: sqlite3.Connection,
    project_id: int,
    expected_project_revision: int,
) -> None:
    _require_strict_positive_int(project_id, "project_id")
    _require_strict_positive_int(expected_project_revision, "expected_project_revision")
    row = conn.execute(
        "SELECT revision, archived_at FROM dataset_projects WHERE id = ?",
        (project_id,),
    ).fetchone()
    if row is None:
        raise AnnotationProjectNotFoundError(project_id)
    current_revision = int(row["revision"])
    if current_revision != expected_project_revision:
        raise AnnotationProjectRevisionConflictError(
            project_id,
            expected_project_revision,
            current_revision,
        )
    if row["archived_at"] is not None:
        raise AnnotationProjectStateConflictError(project_id, "archived")


def _require_project_revision_for_read(
    conn: sqlite3.Connection,
    project_id: int,
    expected_project_revision: int,
) -> None:
    _require_strict_positive_int(project_id, "project_id")
    _require_strict_positive_int(expected_project_revision, "expected_project_revision")
    row = conn.execute(
        "SELECT revision FROM dataset_projects WHERE id = ?",
        (project_id,),
    ).fetchone()
    if row is None:
        raise AnnotationProjectNotFoundError(project_id)
    current_revision = int(row["revision"])
    if current_revision != expected_project_revision:
        raise AnnotationProjectRevisionConflictError(
            project_id,
            expected_project_revision,
            current_revision,
        )


def _inspect_regular_file_identity(
    project_id: int,
    subject_id: int | None,
    indexed_path: str,
) -> FileIdentityRecord:
    resolved_path = resolve_existing_indexed_image_path(
        indexed_path,
        backend_file=__file__,
        allow_symlink=False,
    )
    if resolved_path is None:
        raise AnnotationSubjectIdentityConflictError(
            project_id,
            subject_id,
            indexed_path,
            "the current source file is missing or is not a regular file",
        )
    try:
        current = os.lstat(resolved_path)
    except (FileNotFoundError, NotADirectoryError) as error:
        raise AnnotationSubjectIdentityConflictError(
            project_id,
            subject_id,
            indexed_path,
            "the current source file disappeared during inspection",
        ) from error
    except OSError as error:
        raise AnnotationSubjectIdentityConflictError(
            project_id,
            subject_id,
            indexed_path,
            f"the current source file could not be inspected: {error}",
        ) from error
    if not stat.S_ISREG(current.st_mode):
        raise AnnotationSubjectIdentityConflictError(
            project_id,
            subject_id,
            indexed_path,
            "the current source path is not a regular file",
        )
    return {
        "path": indexed_path,
        "path_key": indexed_image_path_match_key(indexed_path),
        "size": int(current.st_size),
        "mtime_ns": str(current.st_mtime_ns),
        "device": str(current.st_dev),
        "inode": str(current.st_ino),
    }


def _read_current_library_identity(
    conn: sqlite3.Connection,
    project_id: int,
    source_image_id: int,
    subject_id: int | None,
) -> FileIdentityRecord:
    _require_strict_positive_int(source_image_id, "source_image_id")
    row = conn.execute(
        """
        SELECT images.path
        FROM dataset_project_items i
        JOIN images ON images.id = i.image_id
        WHERE i.project_id = ?
          AND i.item_type = 'library'
          AND i.source_image_id = ?
        """,
        (project_id, source_image_id),
    ).fetchone()
    if row is None:
        raise AnnotationSubjectNotInProjectError(
            project_id,
            "project_library",
            str(source_image_id),
        )
    return _inspect_regular_file_identity(
        project_id,
        subject_id,
        str(row["path"]),
    )


def _library_subject_key(
    source_image_id: int,
    identity: FileIdentityRecord,
) -> str:
    identity_json = json.dumps(
        {
            "device": identity["device"],
            "inode": identity["inode"],
            "mtime_ns": identity["mtime_ns"],
            "path_key": identity["path_key"],
            "size": identity["size"],
            "source_image_id": source_image_id,
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    digest = hashlib.sha256(identity_json.encode("utf-8")).hexdigest()
    return f"project_library:{source_image_id}:{digest}"


def _local_subject_key(
    path_key: str,
    size: int,
    mtime_ns: str,
    device: str,
    inode: str,
) -> str:
    identity_json = json.dumps(
        {
            "device": device,
            "inode": inode,
            "mtime_ns": mtime_ns,
            "path_key": path_key,
            "size": size,
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    digest = hashlib.sha256(identity_json.encode("utf-8")).hexdigest()
    return f"project_local:{digest}"


def _read_current_local_membership(
    conn: sqlite3.Connection,
    project_id: int,
    local_path: str,
) -> sqlite3.Row:
    if type(local_path) is not str or not local_path:
        raise AnnotationContentValidationError(
            "local_path",
            "must be a non-empty string",
        )
    path_key = indexed_image_path_match_key(local_path)
    row = conn.execute(
        """
        SELECT s.path, s.path_key, s.size, s.mtime_ns, s.device, s.inode
        FROM dataset_project_items i
        JOIN dataset_project_local_sources s
          ON s.project_id = i.project_id AND s.id = i.local_source_id
        WHERE i.project_id = ?
          AND i.item_type = 'local'
          AND s.path_key = ?
        """,
        (project_id, path_key),
    ).fetchone()
    if row is None:
        raise AnnotationSubjectNotInProjectError(
            project_id,
            "project_local",
            local_path,
        )
    return row


def _require_local_file_identity(
    project_id: int,
    subject_id: int | None,
    row: sqlite3.Row,
) -> None:
    path = str(row["path"])
    try:
        current = os.lstat(path)
    except (FileNotFoundError, NotADirectoryError) as error:
        raise AnnotationSubjectIdentityConflictError(
            project_id,
            subject_id,
            path,
            "the saved local file is missing",
        ) from error
    except OSError as error:
        raise AnnotationSubjectIdentityConflictError(
            project_id,
            subject_id,
            path,
            f"the saved local file could not be inspected: {error}",
        ) from error
    if not stat.S_ISREG(current.st_mode):
        raise AnnotationSubjectIdentityConflictError(
            project_id,
            subject_id,
            path,
            "the saved local path is not a regular file",
        )
    expected = (
        int(row["size"]),
        int(str(row["mtime_ns"])),
        int(str(row["device"])),
        int(str(row["inode"])),
    )
    observed = (
        int(current.st_size),
        int(current.st_mtime_ns),
        int(current.st_dev),
        int(current.st_ino),
    )
    if observed != expected:
        raise AnnotationSubjectIdentityConflictError(
            project_id,
            subject_id,
            path,
            "the saved local file identity changed",
        )


def _read_subject_row(
    conn: sqlite3.Connection,
    subject_id: int,
) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT id, project_id, subject_kind, subject_key,
               library_source_image_id, library_path_key, library_size,
               library_mtime_ns, library_device, library_inode,
               local_path, local_path_key,
               local_size, local_mtime_ns, local_device, local_inode,
               created_at
        FROM annotation_subjects
        WHERE id = ?
        """,
        (subject_id,),
    ).fetchone()


def _read_project_subject_by_key(
    conn: sqlite3.Connection,
    project_id: int,
    subject_key: str,
) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT id, project_id, subject_kind, subject_key,
               library_source_image_id, library_path_key, library_size,
               library_mtime_ns, library_device, library_inode,
               local_path, local_path_key,
               local_size, local_mtime_ns, local_device, local_inode,
               created_at
        FROM annotation_subjects
        WHERE project_id = ? AND subject_key = ?
        """,
        (project_id, subject_key),
    ).fetchone()


def _subject_record(row: sqlite3.Row) -> AnnotationSubjectRecord:
    return {
        "id": int(row["id"]),
        "project_id": int(row["project_id"]),
        "subject_kind": cast(AnnotationSubjectKind, str(row["subject_kind"])),
        "subject_key": str(row["subject_key"]),
        "library_source_image_id": (
            int(row["library_source_image_id"])
            if row["library_source_image_id"] is not None
            else None
        ),
        "library_path_key": (
            str(row["library_path_key"])
            if row["library_path_key"] is not None
            else None
        ),
        "library_size": (
            int(row["library_size"]) if row["library_size"] is not None else None
        ),
        "library_mtime_ns": (
            str(row["library_mtime_ns"])
            if row["library_mtime_ns"] is not None
            else None
        ),
        "library_device": (
            str(row["library_device"]) if row["library_device"] is not None else None
        ),
        "library_inode": (
            str(row["library_inode"]) if row["library_inode"] is not None else None
        ),
        "local_path": str(row["local_path"]) if row["local_path"] is not None else None,
        "local_path_key": (
            str(row["local_path_key"]) if row["local_path_key"] is not None else None
        ),
        "local_size": int(row["local_size"]) if row["local_size"] is not None else None,
        "local_mtime_ns": (
            str(row["local_mtime_ns"]) if row["local_mtime_ns"] is not None else None
        ),
        "local_device": (
            str(row["local_device"]) if row["local_device"] is not None else None
        ),
        "local_inode": (
            str(row["local_inode"]) if row["local_inode"] is not None else None
        ),
        "created_at": str(row["created_at"]),
    }


def _require_subject_for_project(
    conn: sqlite3.Connection,
    project_id: int,
    subject_id: int,
) -> sqlite3.Row:
    _require_strict_positive_int(subject_id, "subject_id")
    row = _read_subject_row(conn, subject_id)
    if row is None:
        raise AnnotationSubjectNotFoundError(subject_id)
    actual_project_id = int(row["project_id"])
    if actual_project_id != project_id:
        raise AnnotationSubjectProjectConflictError(
            project_id,
            subject_id,
            actual_project_id,
        )
    return row


def _require_current_subject_membership(
    conn: sqlite3.Connection,
    project_id: int,
    subject_row: sqlite3.Row,
) -> None:
    subject_id = int(subject_row["id"])
    if subject_row["subject_kind"] == "project_library":
        identity = _read_current_library_identity(
            conn,
            project_id,
            int(subject_row["library_source_image_id"]),
            subject_id,
        )
        expected = (
            str(subject_row["library_path_key"]),
            int(subject_row["library_size"]),
            str(subject_row["library_mtime_ns"]),
            str(subject_row["library_device"]),
            str(subject_row["library_inode"]),
        )
        observed = (
            identity["path_key"],
            identity["size"],
            identity["mtime_ns"],
            identity["device"],
            identity["inode"],
        )
        if observed != expected:
            raise AnnotationSubjectIdentityConflictError(
                project_id,
                subject_id,
                identity["path"],
                "the saved Library file identity changed",
            )
        return
    membership = conn.execute(
        """
        SELECT s.path, s.path_key, s.size, s.mtime_ns, s.device, s.inode
        FROM dataset_project_items i
        JOIN dataset_project_local_sources s
          ON s.project_id = i.project_id AND s.id = i.local_source_id
        WHERE i.project_id = ?
          AND i.item_type = 'local'
          AND s.path_key = ?
          AND s.size = ?
          AND s.mtime_ns = ?
          AND s.device = ?
          AND s.inode = ?
        """,
        (
            project_id,
            subject_row["local_path_key"],
            subject_row["local_size"],
            subject_row["local_mtime_ns"],
            subject_row["local_device"],
            subject_row["local_inode"],
        ),
    ).fetchone()
    if membership is None:
        raise AnnotationSubjectNotInProjectError(
            project_id,
            "project_local",
            str(subject_row["subject_key"]),
        )
    _require_local_file_identity(project_id, subject_id, membership)


def _get_or_create_library_subject(
    conn: sqlite3.Connection,
    project_id: int,
    source_image_id: int,
) -> sqlite3.Row:
    identity = _read_current_library_identity(
        conn,
        project_id,
        source_image_id,
        None,
    )
    subject_key = _library_subject_key(source_image_id, identity)
    conn.execute(
        """
        INSERT OR IGNORE INTO annotation_subjects (
            project_id, subject_kind, subject_key, library_source_image_id,
            library_path_key, library_size, library_mtime_ns,
            library_device, library_inode
        ) VALUES (?, 'project_library', ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            project_id,
            subject_key,
            source_image_id,
            identity["path_key"],
            identity["size"],
            identity["mtime_ns"],
            identity["device"],
            identity["inode"],
        ),
    )
    row = _read_project_subject_by_key(conn, project_id, subject_key)
    if row is None:
        raise RuntimeError(
            f"Annotation library subject insert returned no row: project_id={project_id}, "
            f"source_image_id={source_image_id}"
        )
    return row


def _get_or_create_local_subject(
    conn: sqlite3.Connection,
    project_id: int,
    local_path: str,
) -> sqlite3.Row:
    membership = _read_current_local_membership(conn, project_id, local_path)
    _require_local_file_identity(project_id, None, membership)
    subject_key = _local_subject_key(
        str(membership["path_key"]),
        int(membership["size"]),
        str(membership["mtime_ns"]),
        str(membership["device"]),
        str(membership["inode"]),
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO annotation_subjects (
            project_id, subject_kind, subject_key, local_path, local_path_key,
            local_size, local_mtime_ns, local_device, local_inode
        ) VALUES (?, 'project_local', ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            project_id,
            subject_key,
            membership["path"],
            membership["path_key"],
            membership["size"],
            membership["mtime_ns"],
            membership["device"],
            membership["inode"],
        ),
    )
    row = _read_project_subject_by_key(conn, project_id, subject_key)
    if row is None:
        raise RuntimeError(
            f"Annotation local subject insert returned no row: project_id={project_id}, "
            f"path={membership['path']!r}"
        )
    return row


def _ensure_head_row(conn: sqlite3.Connection, subject_id: int) -> None:
    conn.execute(
        """
        INSERT OR IGNORE INTO annotation_heads (
            subject_id, annotation_kind, generation
        ) VALUES (?, 'training_caption', 0)
        """,
        (subject_id,),
    )


def _read_head_row(conn: sqlite3.Connection, subject_id: int) -> sqlite3.Row:
    row = conn.execute(
        """
        SELECT subject_id, annotation_kind, active_revision_id,
               reviewed_revision_id, export_revision_id, generation
        FROM annotation_heads
        WHERE subject_id = ? AND annotation_kind = 'training_caption'
        """,
        (subject_id,),
    ).fetchone()
    if row is None:
        raise RuntimeError(
            f"Annotation head row is missing for subject_id={subject_id}"
        )
    return row


def _head_record(row: sqlite3.Row) -> AnnotationHeadRecord:
    return {
        "subject_id": int(row["subject_id"]),
        "annotation_kind": "training_caption",
        "active_revision_id": (
            int(row["active_revision_id"])
            if row["active_revision_id"] is not None
            else None
        ),
        "reviewed_revision_id": (
            int(row["reviewed_revision_id"])
            if row["reviewed_revision_id"] is not None
            else None
        ),
        "export_revision_id": (
            int(row["export_revision_id"])
            if row["export_revision_id"] is not None
            else None
        ),
        "generation": int(row["generation"]),
    }


def _require_head_generation(
    head_row: sqlite3.Row,
    subject_id: int,
    expected_head_generation: int,
) -> None:
    _require_strict_non_negative_int(
        expected_head_generation,
        "expected_head_generation",
    )
    current_generation = int(head_row["generation"])
    if current_generation != expected_head_generation:
        raise AnnotationHeadConflictError(
            subject_id,
            expected_head_generation,
            current_generation,
        )


def _read_revision_row(
    conn: sqlite3.Connection,
    revision_id: int,
) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT id, subject_id, annotation_kind, parent_revision_id,
               restored_from_revision_id, content_json, content_sha256,
               source_kind, author_class, provider, model, created_at
        FROM annotation_revisions
        WHERE id = ?
        """,
        (revision_id,),
    ).fetchone()


def _revision_record(row: sqlite3.Row) -> AnnotationRevisionRecord:
    raw_content = json.loads(str(row["content_json"]))
    content: TrainingCaptionContent = {
        "content_version": cast(Literal[1], raw_content["content_version"]),
        "booru_caption": str(raw_content["booru_caption"]),
        "nl_caption": str(raw_content["nl_caption"]),
        "caption_type": cast(CaptionType, str(raw_content["caption_type"])),
    }
    return {
        "id": int(row["id"]),
        "subject_id": int(row["subject_id"]),
        "annotation_kind": "training_caption",
        "parent_revision_id": (
            int(row["parent_revision_id"])
            if row["parent_revision_id"] is not None
            else None
        ),
        "restored_from_revision_id": (
            int(row["restored_from_revision_id"])
            if row["restored_from_revision_id"] is not None
            else None
        ),
        "content": content,
        "content_json": str(row["content_json"]),
        "content_sha256": str(row["content_sha256"]),
        "source_kind": cast(AnnotationSourceKind, str(row["source_kind"])),
        "author_class": cast(AnnotationAuthorClass, str(row["author_class"])),
        "provider": str(row["provider"]) if row["provider"] is not None else None,
        "model": str(row["model"]) if row["model"] is not None else None,
        "created_at": str(row["created_at"]),
    }


def _require_revision_for_subject(
    conn: sqlite3.Connection,
    subject_id: int,
    revision_id: int,
) -> sqlite3.Row:
    _require_strict_positive_int(revision_id, "revision_id")
    row = _read_revision_row(conn, revision_id)
    if row is None:
        raise AnnotationRevisionNotFoundError(revision_id)
    actual_subject_id = int(row["subject_id"])
    if actual_subject_id != subject_id:
        raise AnnotationRevisionSubjectConflictError(
            subject_id,
            revision_id,
            actual_subject_id,
        )
    return row


def _insert_revision(
    conn: sqlite3.Connection,
    subject_id: int,
    parent_revision_id: int | None,
    restored_from_revision_id: int | None,
    content_json: str,
    content_sha256: str,
    source_kind: AnnotationSourceKind,
    author_class: AnnotationAuthorClass,
    provider: str | None,
    model: str | None,
) -> sqlite3.Row:
    cursor = conn.execute(
        """
        INSERT INTO annotation_revisions (
            subject_id, annotation_kind, parent_revision_id,
            restored_from_revision_id, content_json, content_sha256,
            source_kind, author_class, provider, model
        ) VALUES (?, 'training_caption', ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            subject_id,
            parent_revision_id,
            restored_from_revision_id,
            content_json,
            content_sha256,
            source_kind,
            author_class,
            provider,
            model,
        ),
    )
    revision_id = cursor.lastrowid
    if revision_id is None:
        raise RuntimeError(
            f"Annotation revision insert returned no row ID: subject_id={subject_id}"
        )
    row = _read_revision_row(conn, int(revision_id))
    if row is None:
        raise RuntimeError(
            f"Annotation revision insert returned no row: revision_id={revision_id}"
        )
    return row


def _update_active_head(
    conn: sqlite3.Connection,
    subject_id: int,
    revision_id: int,
    expected_head_generation: int,
) -> sqlite3.Row:
    cursor = conn.execute(
        """
        UPDATE annotation_heads
        SET active_revision_id = ?, generation = generation + 1
        WHERE subject_id = ?
          AND annotation_kind = 'training_caption'
          AND generation = ?
        """,
        (revision_id, subject_id, expected_head_generation),
    )
    if cursor.rowcount != 1:
        current = _read_head_row(conn, subject_id)
        raise AnnotationHeadConflictError(
            subject_id,
            expected_head_generation,
            int(current["generation"]),
        )
    return _read_head_row(conn, subject_id)


def _create_revision_for_subject(
    conn: sqlite3.Connection,
    subject_row: sqlite3.Row,
    expected_head_generation: int,
    content_json: str,
    content_sha256: str,
    source_kind: AnnotationSourceKind,
    author_class: AnnotationAuthorClass,
    provider: str | None,
    model: str | None,
) -> AnnotationMutationRecord:
    subject_id = int(subject_row["id"])
    _ensure_head_row(conn, subject_id)
    head_row = _read_head_row(conn, subject_id)
    _require_head_generation(head_row, subject_id, expected_head_generation)
    revision_row = _insert_revision(
        conn,
        subject_id,
        (
            int(head_row["active_revision_id"])
            if head_row["active_revision_id"] is not None
            else None
        ),
        None,
        content_json,
        content_sha256,
        source_kind,
        author_class,
        provider,
        model,
    )
    updated_head = _update_active_head(
        conn,
        subject_id,
        int(revision_row["id"]),
        expected_head_generation,
    )
    return {
        "subject": _subject_record(subject_row),
        "revision": _revision_record(revision_row),
        "head": _head_record(updated_head),
    }


def create_project_library_training_caption_revision(
    project_id: int,
    expected_project_revision: int,
    source_image_id: int,
    expected_head_generation: int,
    content: Mapping[str, object],
    source_kind: AnnotationSourceKind,
    author_class: AnnotationAuthorClass,
    provider: str | None,
    model: str | None,
) -> AnnotationMutationRecord:
    """Append one Library-item training caption and advance its active head."""
    _normalized, content_json, content_sha256 = _canonical_training_caption_content(
        content
    )
    validated_source, validated_author, validated_provider, validated_model = (
        _validate_provenance(source_kind, author_class, provider, model)
    )
    with get_db() as conn:
        _begin_write(conn)
        _require_project_for_write(conn, project_id, expected_project_revision)
        subject_row = _get_or_create_library_subject(
            conn,
            project_id,
            source_image_id,
        )
        return _create_revision_for_subject(
            conn,
            subject_row,
            expected_head_generation,
            content_json,
            content_sha256,
            validated_source,
            validated_author,
            validated_provider,
            validated_model,
        )


def create_project_local_training_caption_revision(
    project_id: int,
    expected_project_revision: int,
    local_path: str,
    expected_head_generation: int,
    content: Mapping[str, object],
    source_kind: AnnotationSourceKind,
    author_class: AnnotationAuthorClass,
    provider: str | None,
    model: str | None,
) -> AnnotationMutationRecord:
    """Append one local-item training caption and advance its active head."""
    _normalized, content_json, content_sha256 = _canonical_training_caption_content(
        content
    )
    validated_source, validated_author, validated_provider, validated_model = (
        _validate_provenance(source_kind, author_class, provider, model)
    )
    with get_db() as conn:
        _begin_write(conn)
        _require_project_for_write(conn, project_id, expected_project_revision)
        subject_row = _get_or_create_local_subject(conn, project_id, local_path)
        return _create_revision_for_subject(
            conn,
            subject_row,
            expected_head_generation,
            content_json,
            content_sha256,
            validated_source,
            validated_author,
            validated_provider,
            validated_model,
        )


def restore_project_training_caption_revision(
    project_id: int,
    expected_project_revision: int,
    subject_id: int,
    revision_id: int,
    expected_head_generation: int,
) -> AnnotationMutationRecord:
    """Restore historical content by appending a new active revision."""
    with get_db() as conn:
        _begin_write(conn)
        _require_project_for_write(conn, project_id, expected_project_revision)
        subject_row = _require_subject_for_project(conn, project_id, subject_id)
        _require_current_subject_membership(conn, project_id, subject_row)
        target_row = _require_revision_for_subject(conn, subject_id, revision_id)
        _ensure_head_row(conn, subject_id)
        head_row = _read_head_row(conn, subject_id)
        _require_head_generation(head_row, subject_id, expected_head_generation)
        restored_row = _insert_revision(
            conn,
            subject_id,
            (
                int(head_row["active_revision_id"])
                if head_row["active_revision_id"] is not None
                else None
            ),
            revision_id,
            str(target_row["content_json"]),
            str(target_row["content_sha256"]),
            "restore",
            "user",
            None,
            None,
        )
        updated_head = _update_active_head(
            conn,
            subject_id,
            int(restored_row["id"]),
            expected_head_generation,
        )
        return {
            "subject": _subject_record(subject_row),
            "revision": _revision_record(restored_row),
            "head": _head_record(updated_head),
        }


def select_project_training_caption_head(
    project_id: int,
    expected_project_revision: int,
    subject_id: int,
    head_kind: AnnotationHeadKind,
    revision_id: int,
    expected_head_generation: int,
) -> AnnotationHeadRecord:
    """Move one named head to an existing revision under generation CAS."""
    if type(head_kind) is not str or head_kind not in _HEAD_COLUMNS:
        raise AnnotationContentValidationError(
            "head_kind",
            "must be active, reviewed, or export",
        )
    head_column = _HEAD_COLUMNS[head_kind]
    with get_db() as conn:
        _begin_write(conn)
        _require_project_for_write(conn, project_id, expected_project_revision)
        subject_row = _require_subject_for_project(conn, project_id, subject_id)
        _require_current_subject_membership(conn, project_id, subject_row)
        _require_revision_for_subject(conn, subject_id, revision_id)
        _ensure_head_row(conn, subject_id)
        head_row = _read_head_row(conn, subject_id)
        _require_head_generation(head_row, subject_id, expected_head_generation)
        cursor = conn.execute(
            f"""
            UPDATE annotation_heads
            SET {head_column} = ?, generation = generation + 1
            WHERE subject_id = ?
              AND annotation_kind = 'training_caption'
              AND generation = ?
            """,
            (revision_id, subject_id, expected_head_generation),
        )
        if cursor.rowcount != 1:
            current = _read_head_row(conn, subject_id)
            raise AnnotationHeadConflictError(
                subject_id,
                expected_head_generation,
                int(current["generation"]),
            )
        return _head_record(_read_head_row(conn, subject_id))


def get_project_training_caption_head(
    project_id: int,
    expected_project_revision: int,
    subject_id: int,
) -> AnnotationHeadRecord:
    """Read all three selected heads for one project annotation subject."""
    with get_db() as conn:
        _require_project_revision_for_read(
            conn,
            project_id,
            expected_project_revision,
        )
        _require_subject_for_project(conn, project_id, subject_id)
        return _head_record(_read_head_row(conn, subject_id))


def validate_project_training_caption_subject(
    project_id: int,
    expected_project_revision: int,
    subject_id: int,
) -> AnnotationSubjectRecord:
    """Require a subject to match current project membership and file identity."""
    with get_db() as conn:
        _require_project_revision_for_read(
            conn,
            project_id,
            expected_project_revision,
        )
        subject_row = _require_subject_for_project(conn, project_id, subject_id)
        _require_current_subject_membership(conn, project_id, subject_row)
        return _subject_record(subject_row)


def _resolved_head_record(
    conn: sqlite3.Connection,
    subject_key: str,
    subject_row: sqlite3.Row | None,
) -> ResolvedAnnotationHeadRecord:
    if subject_row is None:
        return {
            "subject_key": subject_key,
            "subject": None,
            "head": None,
            "active_revision": None,
            "generation": 0,
        }
    head = _head_record(_read_head_row(conn, int(subject_row["id"])))
    active_revision_id = head["active_revision_id"]
    active_revision = (
        _read_revision_row(conn, active_revision_id)
        if active_revision_id is not None
        else None
    )
    if active_revision_id is not None and active_revision is None:
        raise RuntimeError(
            "Annotation active revision is missing: "
            f"subject_id={subject_row['id']}, revision_id={active_revision_id}"
        )
    return {
        "subject_key": subject_key,
        "subject": _subject_record(subject_row),
        "head": head,
        "active_revision": (
            _revision_record(active_revision) if active_revision is not None else None
        ),
        "generation": head["generation"],
    }


def resolve_project_library_training_caption_head(
    project_id: int,
    expected_project_revision: int,
    source_image_id: int,
) -> ResolvedAnnotationHeadRecord:
    """Resolve a current Library project item without creating ledger rows."""
    with get_db() as conn:
        _require_project_revision_for_read(
            conn,
            project_id,
            expected_project_revision,
        )
        identity = _read_current_library_identity(
            conn,
            project_id,
            source_image_id,
            None,
        )
        subject_key = _library_subject_key(source_image_id, identity)
        subject_row = _read_project_subject_by_key(
            conn,
            project_id,
            subject_key,
        )
        return _resolved_head_record(conn, subject_key, subject_row)


def resolve_project_local_training_caption_head(
    project_id: int,
    expected_project_revision: int,
    local_path: str,
) -> ResolvedAnnotationHeadRecord:
    """Resolve a current local project item after exact identity validation."""
    with get_db() as conn:
        _require_project_revision_for_read(
            conn,
            project_id,
            expected_project_revision,
        )
        membership = _read_current_local_membership(conn, project_id, local_path)
        _require_local_file_identity(project_id, None, membership)
        subject_key = _local_subject_key(
            str(membership["path_key"]),
            int(membership["size"]),
            str(membership["mtime_ns"]),
            str(membership["device"]),
            str(membership["inode"]),
        )
        subject_row = _read_project_subject_by_key(
            conn,
            project_id,
            subject_key,
        )
        return _resolved_head_record(conn, subject_key, subject_row)


def _read_project_training_caption_head_items(
    conn: sqlite3.Connection,
    subject_rows: list[sqlite3.Row],
) -> list[ProjectTrainingCaptionHeadItem]:
    if not subject_rows:
        return []
    subject_ids = [int(row["id"]) for row in subject_rows]
    placeholders = ", ".join("?" for _subject_id in subject_ids)
    detail_rows = conn.execute(
        f"""
        SELECT h.subject_id, h.annotation_kind, h.active_revision_id,
               h.reviewed_revision_id, h.export_revision_id, h.generation,
               r.id, r.parent_revision_id, r.restored_from_revision_id,
               r.content_json, r.content_sha256, r.source_kind,
               r.author_class, r.provider, r.model, r.created_at
        FROM annotation_heads h
        JOIN annotation_revisions r
          ON r.subject_id = h.subject_id
         AND r.annotation_kind = h.annotation_kind
         AND r.id = h.active_revision_id
        WHERE h.subject_id IN ({placeholders})
          AND h.annotation_kind = 'training_caption'
        """,
        tuple(subject_ids),
    ).fetchall()
    details = {int(row["subject_id"]): row for row in detail_rows}
    missing_subject_ids = [
        subject_id for subject_id in subject_ids if subject_id not in details
    ]
    if missing_subject_ids:
        raise RuntimeError(
            "Annotation subjects are missing active training-caption heads: "
            f"subject_ids={missing_subject_ids}"
        )
    return [
        {
            "subject": _subject_record(subject_row),
            "head": _head_record(details[int(subject_row["id"])]),
            "active_revision": _revision_record(details[int(subject_row["id"])]),
        }
        for subject_row in subject_rows
    ]


def list_project_training_caption_heads(
    project_id: int,
    expected_project_revision: int,
    after_subject_id: int | None,
    limit: int,
) -> ProjectTrainingCaptionHeadPage:
    """List current project training-caption heads by stable subject cursor."""
    _require_strict_positive_int(limit, "limit")
    if limit > 200:
        raise AnnotationContentValidationError("limit", "must be at most 200")
    if after_subject_id is not None:
        _require_strict_positive_int(after_subject_id, "after_subject_id")
    with get_db() as conn:
        _require_project_revision_for_read(
            conn,
            project_id,
            expected_project_revision,
        )
        scan_after_subject_id = after_subject_id or 0
        current_rows: list[sqlite3.Row] = []
        while len(current_rows) < limit + 1:
            rows = conn.execute(
                """
                SELECT id, project_id, subject_kind, subject_key,
                       library_source_image_id, library_path_key, library_size,
                       library_mtime_ns, library_device, library_inode,
                       local_path, local_path_key,
                       local_size, local_mtime_ns, local_device, local_inode,
                       created_at
                FROM annotation_subjects
                WHERE project_id = ? AND id > ?
                ORDER BY id ASC
                LIMIT ?
                """,
                (project_id, scan_after_subject_id, 256),
            ).fetchall()
            if not rows:
                break
            for subject_row in rows:
                scan_after_subject_id = int(subject_row["id"])
                try:
                    _require_current_subject_membership(
                        conn,
                        project_id,
                        subject_row,
                    )
                except (
                    AnnotationSubjectNotInProjectError,
                    AnnotationSubjectIdentityConflictError,
                ):
                    continue
                current_rows.append(subject_row)
                if len(current_rows) == limit + 1:
                    break
            if len(rows) < 256:
                break
        has_more = len(current_rows) > limit
        visible_rows = current_rows[:limit]
        items = _read_project_training_caption_head_items(conn, visible_rows)
    return {
        "items": items,
        "has_more": has_more,
        "next_after_subject_id": (
            int(visible_rows[-1]["id"]) if has_more and visible_rows else None
        ),
    }


def list_project_training_caption_revisions(
    project_id: int,
    expected_project_revision: int,
    subject_id: int,
    before_revision_id: int | None,
    limit: int,
) -> AnnotationRevisionPage:
    """List immutable history newest-first using a stable revision cursor."""
    _require_strict_positive_int(limit, "limit")
    if limit > 200:
        raise AnnotationContentValidationError("limit", "must be at most 200")
    if before_revision_id is not None:
        _require_strict_positive_int(before_revision_id, "before_revision_id")
    with get_db() as conn:
        _require_project_revision_for_read(
            conn,
            project_id,
            expected_project_revision,
        )
        _require_subject_for_project(conn, project_id, subject_id)
        if before_revision_id is None:
            rows = conn.execute(
                """
                SELECT id, subject_id, annotation_kind, parent_revision_id,
                       restored_from_revision_id, content_json, content_sha256,
                       source_kind, author_class, provider, model, created_at
                FROM annotation_revisions
                WHERE subject_id = ? AND annotation_kind = 'training_caption'
                ORDER BY id DESC
                LIMIT ?
                """,
                (subject_id, limit + 1),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT id, subject_id, annotation_kind, parent_revision_id,
                       restored_from_revision_id, content_json, content_sha256,
                       source_kind, author_class, provider, model, created_at
                FROM annotation_revisions
                WHERE subject_id = ?
                  AND annotation_kind = 'training_caption'
                  AND id < ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (subject_id, before_revision_id, limit + 1),
            ).fetchall()
    has_more = len(rows) > limit
    visible_rows = rows[:limit]
    items = [_revision_record(row) for row in visible_rows]
    return {
        "items": items,
        "has_more": has_more,
        "next_before_revision_id": (
            int(visible_rows[-1]["id"]) if has_more and visible_rows else None
        ),
    }
