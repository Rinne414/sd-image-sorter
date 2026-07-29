"""Add immutable Dataset Project training-caption revisions."""

from __future__ import annotations

import sqlite3
from typing import Literal

from migrations._schema_common import table_exists


VERSION = 34
NAME = "annotation_revisions"

_TABLES = (
    "annotation_subjects",
    "annotation_revisions",
    "annotation_heads",
)
_TRIGGERS = (
    "trg_annotation_subjects_immutable",
    "trg_annotation_revisions_immutable",
    "trg_annotation_heads_identity_immutable",
)
_INDEXES = (
    "uq_annotation_subjects_project_library",
    "uq_annotation_subjects_project_local_identity",
    "idx_annotation_revisions_subject_history",
)


def _schema_object_exists(
    conn: sqlite3.Connection,
    object_type: Literal["index", "trigger"],
    object_name: str,
) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?",
        (object_type, object_name),
    ).fetchone()
    return row is not None


def apply(conn: sqlite3.Connection) -> bool:
    """Create the project-scoped immutable annotation ledger."""
    table_states = tuple(table_exists(conn, table_name) for table_name in _TABLES)
    trigger_states = tuple(
        _schema_object_exists(conn, "trigger", trigger_name)
        for trigger_name in _TRIGGERS
    )
    index_states = tuple(
        _schema_object_exists(conn, "index", index_name) for index_name in _INDEXES
    )
    if all(table_states) and all(trigger_states) and all(index_states):
        return False
    if any(table_states) or any(trigger_states) or any(index_states):
        raise RuntimeError(
            "Cannot migrate annotation revisions: annotation ledger schema is "
            "partially present"
        )
    if not table_exists(conn, "dataset_projects"):
        raise RuntimeError(
            "Cannot migrate annotation revisions: dataset_projects is missing"
        )
    if not table_exists(conn, "dataset_project_items"):
        raise RuntimeError(
            "Cannot migrate annotation revisions: dataset_project_items is missing"
        )
    if not table_exists(conn, "dataset_project_local_sources"):
        raise RuntimeError(
            "Cannot migrate annotation revisions: "
            "dataset_project_local_sources is missing"
        )

    conn.execute(
        """
        CREATE TABLE annotation_subjects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL
                REFERENCES dataset_projects(id) ON DELETE CASCADE,
            subject_kind TEXT NOT NULL CHECK (
                subject_kind IN ('project_library', 'project_local')
            ),
            subject_key TEXT NOT NULL CHECK (TRIM(subject_key) != ''),
            library_source_image_id INTEGER,
            library_path_key TEXT,
            library_size INTEGER,
            library_mtime_ns TEXT,
            library_device TEXT,
            library_inode TEXT,
            local_path TEXT,
            local_path_key TEXT,
            local_size INTEGER,
            local_mtime_ns TEXT,
            local_device TEXT,
            local_inode TEXT,
            created_at TEXT NOT NULL DEFAULT (
                STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
            ),
            UNIQUE (project_id, subject_key),
            UNIQUE (project_id, id),
            CHECK (
                (
                    subject_kind = 'project_library'
                    AND library_source_image_id IS NOT NULL
                    AND library_source_image_id > 0
                    AND library_path_key IS NOT NULL
                    AND TRIM(library_path_key) != ''
                    AND library_size IS NOT NULL
                    AND library_size >= 0
                    AND library_mtime_ns IS NOT NULL
                    AND library_mtime_ns GLOB '[0-9]*'
                    AND library_mtime_ns NOT GLOB '*[^0-9]*'
                    AND library_device IS NOT NULL
                    AND library_device GLOB '[0-9]*'
                    AND library_device NOT GLOB '*[^0-9]*'
                    AND library_inode IS NOT NULL
                    AND library_inode GLOB '[0-9]*'
                    AND library_inode NOT GLOB '*[^0-9]*'
                    AND local_path IS NULL
                    AND local_path_key IS NULL
                    AND local_size IS NULL
                    AND local_mtime_ns IS NULL
                    AND local_device IS NULL
                    AND local_inode IS NULL
                )
                OR
                (
                    subject_kind = 'project_local'
                    AND library_source_image_id IS NULL
                    AND library_path_key IS NULL
                    AND library_size IS NULL
                    AND library_mtime_ns IS NULL
                    AND library_device IS NULL
                    AND library_inode IS NULL
                    AND local_path IS NOT NULL
                    AND TRIM(local_path) != ''
                    AND local_path_key IS NOT NULL
                    AND TRIM(local_path_key) != ''
                    AND local_size IS NOT NULL
                    AND local_size >= 0
                    AND local_mtime_ns IS NOT NULL
                    AND local_mtime_ns GLOB '[0-9]*'
                    AND local_mtime_ns NOT GLOB '*[^0-9]*'
                    AND local_device IS NOT NULL
                    AND local_device GLOB '[0-9]*'
                    AND local_device NOT GLOB '*[^0-9]*'
                    AND local_inode IS NOT NULL
                    AND local_inode GLOB '[0-9]*'
                    AND local_inode NOT GLOB '*[^0-9]*'
                )
            )
        )
        """
    )
    conn.execute(
        """
        CREATE UNIQUE INDEX uq_annotation_subjects_project_library
        ON annotation_subjects(
            project_id, library_source_image_id, library_path_key,
            library_size, library_mtime_ns, library_device, library_inode
        )
        WHERE subject_kind = 'project_library'
        """
    )
    conn.execute(
        """
        CREATE UNIQUE INDEX uq_annotation_subjects_project_local_identity
        ON annotation_subjects(
            project_id, local_path_key, local_size, local_mtime_ns,
            local_device, local_inode
        )
        WHERE subject_kind = 'project_local'
        """
    )

    conn.execute(
        """
        CREATE TABLE annotation_revisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject_id INTEGER NOT NULL
                REFERENCES annotation_subjects(id) ON DELETE CASCADE,
            annotation_kind TEXT NOT NULL
                CHECK (annotation_kind = 'training_caption'),
            parent_revision_id INTEGER,
            restored_from_revision_id INTEGER,
            content_json TEXT NOT NULL CHECK (
                JSON_VALID(content_json) = 1
                AND JSON_TYPE(content_json) = 'object'
            ),
            content_sha256 TEXT NOT NULL CHECK (
                LENGTH(content_sha256) = 64
                AND content_sha256 NOT GLOB '*[^0-9a-f]*'
            ),
            source_kind TEXT NOT NULL CHECK (
                source_kind IN (
                    'legacy_snapshot', 'manual', 'metadata', 'wd14', 'vlm',
                    'translation', 'sidecar_import', 'restore'
                )
            ),
            author_class TEXT NOT NULL CHECK (
                author_class IN ('system', 'user', 'ai', 'import')
            ),
            provider TEXT,
            model TEXT,
            created_at TEXT NOT NULL DEFAULT (
                STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
            ),
            UNIQUE (subject_id, annotation_kind, id),
            FOREIGN KEY (
                subject_id, annotation_kind, parent_revision_id
            ) REFERENCES annotation_revisions(
                subject_id, annotation_kind, id
            ) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
            FOREIGN KEY (
                subject_id, annotation_kind, restored_from_revision_id
            ) REFERENCES annotation_revisions(
                subject_id, annotation_kind, id
            ) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
            CHECK (
                restored_from_revision_id IS NULL
                OR source_kind = 'restore'
            )
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX idx_annotation_revisions_subject_history
        ON annotation_revisions(subject_id, annotation_kind, id DESC)
        """
    )

    conn.execute(
        """
        CREATE TABLE annotation_heads (
            subject_id INTEGER NOT NULL
                REFERENCES annotation_subjects(id) ON DELETE CASCADE,
            annotation_kind TEXT NOT NULL
                CHECK (annotation_kind = 'training_caption'),
            active_revision_id INTEGER,
            reviewed_revision_id INTEGER,
            export_revision_id INTEGER,
            generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
            PRIMARY KEY (subject_id, annotation_kind),
            FOREIGN KEY (
                subject_id, annotation_kind, active_revision_id
            ) REFERENCES annotation_revisions(
                subject_id, annotation_kind, id
            ) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
            FOREIGN KEY (
                subject_id, annotation_kind, reviewed_revision_id
            ) REFERENCES annotation_revisions(
                subject_id, annotation_kind, id
            ) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
            FOREIGN KEY (
                subject_id, annotation_kind, export_revision_id
            ) REFERENCES annotation_revisions(
                subject_id, annotation_kind, id
            ) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
        )
        """
    )

    conn.execute(
        """
        CREATE TRIGGER trg_annotation_subjects_immutable
        BEFORE UPDATE ON annotation_subjects
        BEGIN
            SELECT RAISE(ABORT, 'annotation subjects are immutable');
        END
        """
    )
    conn.execute(
        """
        CREATE TRIGGER trg_annotation_revisions_immutable
        BEFORE UPDATE ON annotation_revisions
        BEGIN
            SELECT RAISE(ABORT, 'annotation revisions are immutable');
        END
        """
    )
    conn.execute(
        """
        CREATE TRIGGER trg_annotation_heads_identity_immutable
        BEFORE UPDATE OF subject_id, annotation_kind ON annotation_heads
        BEGIN
            SELECT RAISE(ABORT, 'annotation head identity is immutable');
        END
        """
    )
    return True
